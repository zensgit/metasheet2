<template>
  <div class="meta-calendar">
    <div v-if="!dateField" class="meta-calendar__picker">
      <div class="meta-calendar__picker-icon">&#x1F4C5;</div>
      <p>{{ viewRenderLabel('calendar.selectDateField', isZh) }}</p>
      <select class="meta-calendar__field-select" @change="onPickDateField($event)">
        <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
        <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
    </div>

    <template v-else>
      <div class="meta-calendar__header">
        <button class="meta-calendar__nav-btn" @click="goPrevious">&lsaquo;</button>
        <span class="meta-calendar__title">{{ periodLabel }}</span>
        <button class="meta-calendar__nav-btn" @click="goNext">&rsaquo;</button>
        <button class="meta-calendar__today-btn" @click="goToday">{{ viewRenderLabel('calendar.today', isZh) }}</button>
        <button v-if="canCreate" class="meta-calendar__create-btn" @click="onQuickCreate">{{ viewRenderLabel('common.addRecord', isZh) }}</button>
        <label class="meta-calendar__mode-label">
          {{ viewRenderLabel('calendar.view', isZh) }}
          <select class="meta-calendar__mode-select" :value="viewMode" @change="onViewModeChange">
            <option value="month">{{ calendarViewModeLabel('month', isZh) }}</option>
            <option value="week">{{ calendarViewModeLabel('week', isZh) }}</option>
            <option value="day">{{ calendarViewModeLabel('day', isZh) }}</option>
          </select>
        </label>
        <span class="meta-calendar__field-label">
          {{ isZh ? '字段：' : 'Field:' }} <strong>{{ dateField.name }}</strong>
          <button v-if="dateField" class="meta-calendar__change-btn" @click="onResetDateField">{{ viewRenderLabel('calendar.change', isZh) }}</button>
        </span>
      </div>
      <div v-if="calendarHolidayNotice" class="meta-calendar__notice" role="status">
        {{ calendarHolidayNotice }}
      </div>

      <template v-if="viewMode === 'month'">
        <div class="meta-calendar__weekdays">
          <div v-for="d in weekdays" :key="d" class="meta-calendar__weekday">{{ d }}</div>
        </div>

        <div class="meta-calendar__grid meta-calendar__grid--month">
          <div
            v-for="(cell, cellIdx) in monthCells"
            :key="cell.key"
            class="meta-calendar__cell"
            :class="{
              'meta-calendar__cell--outside': !cell.inMonth,
              'meta-calendar__cell--today': cell.isToday,
            }"
            :role="cell.inMonth ? 'button' : undefined"
            :tabindex="cell.inMonth ? 0 : -1"
            :aria-label="cellAriaLabel(cell)"
            :aria-disabled="!cell.inMonth ? 'true' : undefined"
            @click="canCreate && cell.inMonth && emit('create-record', buildCreateRecordData(cell.dateStr))"
            @keydown="onCellKeydown($event, cellIdx, monthCells)"
          >
            <div class="meta-calendar__day-head">
              <span class="meta-calendar__day-num">{{ cell.day }}</span>
              <span v-if="cell.lunarLabel" class="meta-calendar__lunar">{{ cell.lunarLabel }}</span>
            </div>
            <div v-if="cell.holidays.length" class="meta-calendar__holidays">
              <span
                v-for="holiday in cell.holidays.slice(0, 2)"
                :key="`${cell.dateStr}-${holiday.id}`"
                class="meta-calendar__holiday"
                :class="[
                  holiday.isWorkingDay ? 'meta-calendar__holiday--working' : 'meta-calendar__holiday--rest',
                  hasOverrideMarker(holiday) ? 'meta-calendar__holiday--overridden' : null,
                  holiday.overlays && holiday.overlays.length ? 'meta-calendar__holiday--with-overlay' : null,
                  calendarChipSourceClassName(holiday.effective?.source),
                ]"
                :title="buildHolidayTooltip(holiday)"
              >
                {{ holiday.name || fallbackHolidayName(holiday) }}
              </span>
            </div>
            <div class="meta-calendar__events">
              <div
                v-for="ev in cell.events"
                :key="ev.id"
                class="meta-calendar__event"
                :class="{ 'meta-calendar__event--attachment': ev.isAttachmentTitle }"
                @click.stop="emit('select-record', ev.id)"
              >
                <div class="meta-calendar__event-copy">
                  <MetaAttachmentList
                    v-if="ev.isAttachmentTitle"
                    class="meta-calendar__event-attachments"
                    :attachments="ev.attachments"
                    variant="compact"
                    :empty-label="metaCoreLabel('cell.noAttachments', isZh)"
                  />
                  <template v-else>{{ ev.title }}</template>
                </div>
                <div v-if="canComment" class="meta-calendar__event-actions">
                  <button
                    type="button"
                    class="meta-calendar__comment-btn"
                    :class="rowCommentButtonClass(ev.id)"
                    :aria-label="openRecordCommentsAria(ev.title, isZh)"
                    @click.stop="emit('open-comments', ev.id)"
                    @keydown="onRowCommentKeydown($event, ev.id)"
                  >
                    <MetaCommentActionChip :label="commentsChipLabel" :state="rowCommentAffordance(ev.id)" />
                  </button>
                  <button
                    v-if="dateField"
                    type="button"
                    class="meta-calendar__field-comment-btn"
                    :class="fieldCommentButtonClass(ev.id)"
                    :aria-label="openFieldCommentsAria(dateField.name, isZh)"
                    @click.stop="emit('open-field-comments', { recordId: ev.id, fieldId: dateField.id })"
                    @keydown="onFieldCommentKeydown($event, ev.id, dateField.id)"
                  >
                    <MetaCommentAffordance :state="fieldCommentAffordance(ev.id)" />
                  </button>
                </div>
              </div>
              <div v-if="cell.overflow > 0" class="meta-calendar__overflow">{{ calendarMoreEvents(cell.overflow, isZh) }}</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="viewMode === 'week'">
        <div class="meta-calendar__weekdays">
          <div v-for="d in weekdays" :key="d" class="meta-calendar__weekday">{{ d }}</div>
        </div>

        <div class="meta-calendar__grid meta-calendar__grid--week">
          <div
            v-for="(cell, cellIdx) in weekCells"
            :key="cell.key"
            class="meta-calendar__cell meta-calendar__cell--week"
            :class="{
              'meta-calendar__cell--today': cell.isToday,
            }"
            role="button"
            tabindex="0"
            :aria-label="cellAriaLabel(cell)"
            @click="canCreate && emit('create-record', buildCreateRecordData(cell.dateStr))"
            @keydown="onCellKeydown($event, cellIdx, weekCells)"
          >
            <div class="meta-calendar__day-head">
              <span class="meta-calendar__day-num">{{ cell.day }}</span>
              <span v-if="cell.lunarLabel" class="meta-calendar__lunar">{{ cell.lunarLabel }}</span>
            </div>
            <div v-if="cell.holidays.length" class="meta-calendar__holidays">
              <span
                v-for="holiday in cell.holidays.slice(0, 2)"
                :key="`${cell.dateStr}-${holiday.id}`"
                class="meta-calendar__holiday"
                :class="[
                  holiday.isWorkingDay ? 'meta-calendar__holiday--working' : 'meta-calendar__holiday--rest',
                  hasOverrideMarker(holiday) ? 'meta-calendar__holiday--overridden' : null,
                  holiday.overlays && holiday.overlays.length ? 'meta-calendar__holiday--with-overlay' : null,
                  calendarChipSourceClassName(holiday.effective?.source),
                ]"
                :title="buildHolidayTooltip(holiday)"
              >
                {{ holiday.name || fallbackHolidayName(holiday) }}
              </span>
            </div>
            <div class="meta-calendar__events">
              <div
                v-for="ev in cell.events"
                :key="ev.id"
                class="meta-calendar__event"
                :class="{ 'meta-calendar__event--attachment': ev.isAttachmentTitle }"
                @click.stop="emit('select-record', ev.id)"
              >
                <div class="meta-calendar__event-copy">
                  <MetaAttachmentList
                    v-if="ev.isAttachmentTitle"
                    class="meta-calendar__event-attachments"
                    :attachments="ev.attachments"
                    variant="compact"
                    :empty-label="metaCoreLabel('cell.noAttachments', isZh)"
                  />
                  <template v-else>{{ ev.title }}</template>
                </div>
                <div v-if="canComment" class="meta-calendar__event-actions">
                  <button
                    type="button"
                    class="meta-calendar__comment-btn"
                    :class="rowCommentButtonClass(ev.id)"
                    :aria-label="openRecordCommentsAria(ev.title, isZh)"
                    @click.stop="emit('open-comments', ev.id)"
                    @keydown="onRowCommentKeydown($event, ev.id)"
                  >
                    <MetaCommentActionChip :label="commentsChipLabel" :state="rowCommentAffordance(ev.id)" />
                  </button>
                  <button
                    v-if="dateField"
                    type="button"
                    class="meta-calendar__field-comment-btn"
                    :class="fieldCommentButtonClass(ev.id)"
                    :aria-label="openFieldCommentsAria(dateField.name, isZh)"
                    @click.stop="emit('open-field-comments', { recordId: ev.id, fieldId: dateField.id })"
                    @keydown="onFieldCommentKeydown($event, ev.id, dateField.id)"
                  >
                    <MetaCommentAffordance :state="fieldCommentAffordance(ev.id)" />
                  </button>
                </div>
              </div>
              <div v-if="cell.overflow > 0" class="meta-calendar__overflow">{{ calendarMoreEvents(cell.overflow, isZh) }}</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="meta-calendar__day-view">
          <div class="meta-calendar__day-panel">
            <div class="meta-calendar__day-heading">{{ activeDayLabel }}</div>
            <div v-if="activeDayCell.lunarLabel || activeDayCell.holidays.length" class="meta-calendar__day-calendar-meta">
              <span v-if="activeDayCell.lunarLabel" class="meta-calendar__lunar">{{ activeDayCell.lunarLabel }}</span>
              <span
                v-for="holiday in activeDayCell.holidays"
                :key="`${activeDayCell.dateStr}-${holiday.id}`"
                class="meta-calendar__holiday"
                :class="[
                  holiday.isWorkingDay ? 'meta-calendar__holiday--working' : 'meta-calendar__holiday--rest',
                  hasOverrideMarker(holiday) ? 'meta-calendar__holiday--overridden' : null,
                  holiday.overlays && holiday.overlays.length ? 'meta-calendar__holiday--with-overlay' : null,
                  calendarChipSourceClassName(holiday.effective?.source),
                ]"
                :title="buildHolidayTooltip(holiday)"
              >
                {{ holiday.name || fallbackHolidayName(holiday) }}
              </span>
            </div>
            <div class="meta-calendar__day-meta">{{ calendarEventCount(currentDayEvents.length, isZh) }}</div>
            <button
              v-if="canCreate"
              class="meta-calendar__day-create"
              @click="emit('create-record', buildCreateRecordData(activeDayStr))"
            >
              {{ viewRenderLabel('calendar.newRecord', isZh) }}
            </button>
          </div>
          <div class="meta-calendar__day-list">
            <div
              v-for="ev in currentDayEvents"
              :key="ev.id"
              class="meta-calendar__day-event"
              :class="{ 'meta-calendar__day-event--attachment': ev.isAttachmentTitle }"
              role="button"
              tabindex="0"
              @click="emit('select-record', ev.id)"
              @keydown.enter="emit('select-record', ev.id)"
            >
              <div class="meta-calendar__event-copy">
                <MetaAttachmentList
                  v-if="ev.isAttachmentTitle"
                  class="meta-calendar__day-event-attachments"
                  :attachments="ev.attachments"
                  variant="compact"
                  :empty-label="metaCoreLabel('cell.noAttachments', isZh)"
                />
                <template v-else>{{ ev.title }}</template>
              </div>
              <div v-if="canComment" class="meta-calendar__event-actions">
                <button
                  type="button"
                  class="meta-calendar__comment-btn"
                  :class="rowCommentButtonClass(ev.id)"
                  :aria-label="openRecordCommentsAria(ev.title, isZh)"
                  @click.stop="emit('open-comments', ev.id)"
                  @keydown="onRowCommentKeydown($event, ev.id)"
                >
                  <MetaCommentActionChip :label="commentsChipLabel" :state="rowCommentAffordance(ev.id)" />
                </button>
                <button
                  v-if="dateField"
                  type="button"
                  class="meta-calendar__field-comment-btn"
                  :class="fieldCommentButtonClass(ev.id)"
                  :aria-label="openFieldCommentsAria(dateField.name, isZh)"
                  @click.stop="emit('open-field-comments', { recordId: ev.id, fieldId: dateField.id })"
                  @keydown="onFieldCommentKeydown($event, ev.id, dateField.id)"
                >
                  <MetaCommentAffordance :state="fieldCommentAffordance(ev.id)" />
                </button>
              </div>
            </div>
            <div v-if="!currentDayEvents.length" class="meta-calendar__empty-hint">{{ viewRenderLabel('calendar.noRecordsOnDay', isZh) }}</div>
          </div>
        </div>
      </template>
    </template>

    <div v-if="loading" class="meta-calendar__loading">{{ viewRenderLabel('common.loading', isZh) }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaCalendarViewConfig, MetaField, MetaRecord, MultitableCommentPresenceSummary } from '../types'
import { resolveCalendarViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'
import {
  buildCalendarDay,
  buildCalendarDays,
  normalizeDateKey,
  type CalendarDayCell as SharedCalendarDayCell,
  type CalendarHoliday,
  type CalendarVisibleRange,
} from '../../composables/useCalendarDays'
import type {
  CalendarEffectiveChip,
} from '../../services/attendance/effectiveCalendar'
import {
  buildCalendarChipTooltip,
  calendarChipSourceClassName,
  fallbackChipName,
  hasCalendarChipOverrideMarker,
} from '../../services/attendance/calendarChipDisplay'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import { useLocale } from '../../composables/useLocale'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { commentLabel } from '../utils/meta-comment-labels'
import { metaCoreLabel } from '../utils/meta-core-labels'
import {
  calendarCellAriaLabel,
  calendarEventCount,
  calendarMoreEvents,
  calendarViewModeLabel,
  calendarWeekdayShort,
  openFieldCommentsAria,
  openRecordCommentsAria,
  viewRenderLabel,
} from '../utils/meta-view-render-labels'

const MAX_EVENTS_PER_CELL = 3

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canComment?: boolean
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  // CalendarEffectiveChip is a widened CalendarHoliday: legacy id/date/name/
  // isWorkingDay still drives the chip text and working/rest class, while
  // base/effective/layers/overlays (when present) feed tooltip + override
  // marker. PR1 wires this in MultitableWorkbench; existing CalendarHoliday
  // payloads remain compatible since the new fields are optional.
  calendarHolidays?: CalendarEffectiveChip[]
  calendarHolidayNotice?: string | null
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'open-field-comments', payload: { recordId: string; fieldId: string }): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown> }): void
  (e: 'visible-range-change', range: CalendarVisibleRange): void
}>()

const dateFieldId = ref<string | null>(null)
const viewMode = ref<'month' | 'week' | 'day'>('month')
const viewDate = ref(new Date())
const pendingConfigKey = ref<string | null>(null)
const { isZh } = useLocale()
const commentsChipLabel = computed(() => commentLabel('comment.title', isZh.value))

const calendarConfig = computed<Required<MetaCalendarViewConfig>>(() =>
  resolveCalendarViewConfig(props.fields, props.viewConfig),
)

function normalizeCalendarConfig(config?: Partial<Required<MetaCalendarViewConfig>>) {
  return {
    dateFieldId: config?.dateFieldId ?? null,
    endDateFieldId: config?.endDateFieldId ?? null,
    titleFieldId: config?.titleFieldId ?? null,
    defaultView: (config?.defaultView ?? 'month') as 'month' | 'week' | 'day',
    weekStartsOn: config?.weekStartsOn ?? 0,
  }
}

watch(
  calendarConfig,
  (config) => {
    const normalized = normalizeCalendarConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    dateFieldId.value = normalized.dateFieldId
    viewMode.value = normalized.defaultView
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const weekdays = computed(() => {
  const weekStartsOn = calendarConfig.value.weekStartsOn
  const baseWeekdays = [0, 1, 2, 3, 4, 5, 6].map((day) => calendarWeekdayShort(day as 0 | 1 | 2 | 3 | 4 | 5 | 6, isZh.value))
  return [...baseWeekdays.slice(weekStartsOn), ...baseWeekdays.slice(0, weekStartsOn)]
})

const dateFields = computed(() =>
  props.fields.filter((f) => f.type === 'date' || f.type === 'dateTime' || f.type === 'string' || f.type === 'number'),
)

const dateField = computed(() =>
  dateFieldId.value ? props.fields.find((f) => f.id === dateFieldId.value) ?? null : null,
)

const activeDayStr = computed(() => fmt(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, viewDate.value.getDate()))

const titleField = computed(() =>
  props.fields.find((f) => f.id === calendarConfig.value.titleFieldId)
    ?? props.fields.find((f) => f.type === 'string' && f.id !== dateFieldId.value)
    ?? props.fields[0]
    ?? null,
)

type CalendarEvent = {
  id: string
  title: string
  attachments: MetaAttachment[]
  isAttachmentTitle: boolean
}

function attachmentIds(row: MetaRecord, field: MetaField): string[] {
  const rawValue = row.data[field.id]
  if (Array.isArray(rawValue)) return rawValue.map(String)
  if (rawValue) return [String(rawValue)]
  return []
}

function attachmentItems(row: MetaRecord, field: MetaField): MetaAttachment[] {
  const summaryById = new Map((props.attachmentSummaries?.[row.id]?.[field.id] ?? []).map((attachment) => [attachment.id, attachment]))
  return attachmentIds(row, field).map((id) => summaryById.get(id) ?? ({
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }))
}

const eventsByDate = computed(() => {
  const map: Record<string, CalendarEvent[]> = {}
  if (!dateField.value) return map
  for (const row of props.rows) {
    const isAttachmentTitle = titleField.value?.type === 'attachment'
    const attachments = titleField.value && isAttachmentTitle ? attachmentItems(row, titleField.value) : []
    const titleDisplay = titleField.value
      ? formatFieldDisplay({
        field: titleField.value,
        value: row.data[titleField.value.id],
        linkSummaries: props.linkSummaries?.[row.id]?.[titleField.value.id],
        attachmentSummaries: props.attachmentSummaries?.[row.id]?.[titleField.value.id],
        isZh: isZh.value,
      })
      : row.id
    const title = titleDisplay === '—' ? row.id : titleDisplay
    const startDate = normalizeDate(String(row.data[dateField.value.id] ?? ''))
    const endFieldId = calendarConfig.value.endDateFieldId
    const endDate = endFieldId ? normalizeDate(String(row.data[endFieldId] ?? '')) : null
    if (!startDate) continue
    const start = new Date(`${startDate}T00:00:00`)
    const end = new Date(`${(endDate ?? startDate)}T00:00:00`)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
    const safeEnd = end.getTime() >= start.getTime() ? end : start
    for (let cursor = new Date(start); cursor.getTime() <= safeEnd.getTime(); cursor.setDate(cursor.getDate() + 1)) {
      const dateStr = fmt(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())
      if (!map[dateStr]) map[dateStr] = []
      map[dateStr].push({ id: row.id, title, attachments, isAttachmentTitle })
    }
  }
  return map
})

interface CalendarCell extends SharedCalendarDayCell<CalendarEffectiveChip> {
  key: string
  day: number
  dateStr: string
  inMonth: boolean
  events: CalendarEvent[]
  overflow: number
}

function startOfWeek(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const offset = (start.getDay() - calendarConfig.value.weekStartsOn + 7) % 7
  start.setDate(start.getDate() - offset)
  return start
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function buildCell(date: Date, inMonth: boolean): CalendarCell {
  const calendarDay = buildCalendarDay(date, {
    holidays: props.calendarHolidays ?? [],
    isCurrentMonth: inMonth,
    showLunarCalendar: true,
  })
  const dateStr = calendarDay.date
  const all = eventsByDate.value[dateStr] ?? []
  return {
    ...calendarDay,
    key: dateStr,
    day: calendarDay.dayNumber,
    dateStr,
    inMonth,
    events: all.slice(0, MAX_EVENTS_PER_CELL),
    overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL),
  }
}

const todayStr = computed(() => {
  const today = new Date()
  return fmt(today.getFullYear(), today.getMonth() + 1, today.getDate())
})

const monthCells = computed<CalendarCell[]>(() => {
  const first = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), 1)
  const start = startOfWeek(first)
  return buildCalendarDays({
    startDate: start,
    days: 42,
    currentMonth: first,
    holidays: props.calendarHolidays ?? [],
    showLunarCalendar: true,
  }).map((day) => {
    const date = parseDateForCell(day.date)
    return buildCell(date, day.isCurrentMonth)
  })
})

const weekCells = computed<CalendarCell[]>(() => {
  const start = startOfWeek(viewDate.value)
  return Array.from({ length: 7 }, (_, idx) => buildCell(addDays(start, idx), true))
})

const currentDayEvents = computed(() => eventsByDate.value[activeDayStr.value] ?? [])
const activeDayCell = computed(() => buildCell(parseDateForCell(activeDayStr.value), true))

const visibleRange = computed<CalendarVisibleRange | null>(() => {
  if (!dateField.value) return null
  if (viewMode.value === 'month') return rangeFromCells(monthCells.value)
  if (viewMode.value === 'week') return rangeFromCells(weekCells.value)
  return { from: activeDayStr.value, to: activeDayStr.value }
})
const visibleRangeKey = computed(() => visibleRange.value ? `${visibleRange.value.from}|${visibleRange.value.to}` : '')

watch(visibleRangeKey, () => {
  if (visibleRange.value) emit('visible-range-change', visibleRange.value)
}, { immediate: true })

function rowCommentAffordance(recordId: string) {
  return resolveRecordCommentAffordance(props.commentPresence?.[recordId])
}

function fieldCommentAffordance(recordId: string) {
  if (!dateField.value) return resolveFieldCommentAffordance(null, '')
  return resolveFieldCommentAffordance(props.commentPresence?.[recordId], dateField.value.id)
}

function rowCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-calendar__comment-btn', rowCommentAffordance(recordId))
}

function fieldCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-calendar__field-comment-btn', fieldCommentAffordance(recordId))
}

function onRowCommentKeydown(event: KeyboardEvent, recordId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-comments', recordId))
}

function onFieldCommentKeydown(event: KeyboardEvent, recordId: string, fieldId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-field-comments', { recordId, fieldId }))
}

const activeDayLabel = computed(() =>
  viewDate.value.toLocaleDateString('default', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }),
)

const periodLabel = computed(() => {
  if (viewMode.value === 'day') return activeDayLabel.value
  if (viewMode.value === 'week') {
    const start = startOfWeek(viewDate.value)
    const end = addDays(start, 6)
    return `${start.toLocaleDateString('default', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' })}`
  }
  return viewDate.value.toLocaleString('default', { month: 'long', year: 'numeric' })
})

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function normalizeDate(raw: string): string | null {
  return normalizeDateKey(raw)
}

function parseDateForCell(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function rangeFromCells(cells: CalendarCell[]): CalendarVisibleRange | null {
  if (!cells.length) return null
  return {
    from: cells[0]!.dateStr,
    to: cells[cells.length - 1]!.dateStr,
  }
}

// PR2: chip-display helpers (fallback name, override marker, tooltip,
// source class) are extracted to apps/web/src/services/attendance/calendarChipDisplay.ts
// so the multitable Calendar view and attendance personal calendar share one
// implementation. The PR1 visual contract (red/green base + dotted override
// + overlay dot) is preserved; PR2 adds the source border-left accent via
// the shared `calendar-source--{source}` class.

const fallbackHolidayName = fallbackChipName
const hasOverrideMarker = hasCalendarChipOverrideMarker
const buildHolidayTooltip = buildCalendarChipTooltip

function onPickDateField(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  const nextDateFieldId = val || null
  emitConfigUpdate({ dateFieldId: nextDateFieldId })
}

function onResetDateField() {
  emitConfigUpdate({ dateFieldId: null })
}

function emitConfigUpdate(next: Partial<Required<MetaCalendarViewConfig>>) {
  const normalized = normalizeCalendarConfig({
    ...calendarConfig.value,
    dateFieldId: dateFieldId.value,
    defaultView: viewMode.value,
    ...next,
  })
  dateFieldId.value = normalized.dateFieldId
  viewMode.value = normalized.defaultView
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', {
    config: normalized,
  })
}

function onViewModeChange(e: Event) {
  const nextMode = (e.target as HTMLSelectElement).value as 'month' | 'week' | 'day'
  emitConfigUpdate({ defaultView: nextMode })
}

function buildCreateRecordData(dateStr: string): Record<string, unknown> {
  if (!dateField.value) return {}
  const data: Record<string, unknown> = {
    [dateField.value.id]: dateStr,
  }
  const endFieldId = calendarConfig.value.endDateFieldId
  if (endFieldId) data[endFieldId] = dateStr
  return data
}

function onQuickCreate() {
  emit('create-record', buildCreateRecordData(activeDayStr.value))
}

function goPrevious() {
  if (viewMode.value === 'day') {
    viewDate.value = addDays(viewDate.value, -1)
    return
  }
  if (viewMode.value === 'week') {
    viewDate.value = addDays(viewDate.value, -7)
    return
  }
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() - 1, 1)
}

function goNext() {
  if (viewMode.value === 'day') {
    viewDate.value = addDays(viewDate.value, 1)
    return
  }
  if (viewMode.value === 'week') {
    viewDate.value = addDays(viewDate.value, 7)
    return
  }
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, 1)
}

function goToday() {
  viewDate.value = new Date()
}

function cellAriaLabel(cell: CalendarCell): string {
  const d = new Date(cell.dateStr + 'T00:00:00')
  const dateLabel = d.toLocaleDateString(isZh.value ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const total = cell.events.length + cell.overflow
  const annotations = [
    cell.lunarLabel,
    ...cell.holidays.map((holiday) => holiday.name || fallbackHolidayName(holiday)),
  ].filter((item): item is string => Boolean(item))
  return calendarCellAriaLabel(dateLabel, annotations, total, isZh.value)
}

function onCellKeydown(e: KeyboardEvent, cellIdx: number, cells: CalendarCell[]) {
  let next = cellIdx
  if (e.key === 'ArrowRight') next = cellIdx + 1
  else if (e.key === 'ArrowLeft') next = cellIdx - 1
  else if (e.key === 'ArrowDown') next = cellIdx + 7
  else if (e.key === 'ArrowUp') next = cellIdx - 7
  else if (e.key === 'Enter') {
    e.preventDefault()
    const cell = cells[cellIdx]
    if (cell && props.canCreate) {
      emit('create-record', buildCreateRecordData(cell.dateStr))
    }
    return
  } else return

  e.preventDefault()
  if (next >= 0 && next < cells.length) {
    const allCells = document.querySelectorAll('.meta-calendar__cell')
    ;(allCells[next] as HTMLElement)?.focus()
  }
}
</script>

<style scoped>
.meta-calendar { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.meta-calendar__picker { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: #666; font-size: 14px; gap: 12px; }
.meta-calendar__picker-icon { font-size: 36px; opacity: 0.5; }
.meta-calendar__field-select { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-calendar__header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #eee; flex-wrap: wrap; }
.meta-calendar__nav-btn { width: 28px; height: 28px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.meta-calendar__nav-btn:hover { background: #f5f5f5; }
.meta-calendar__title { font-size: 15px; font-weight: 600; color: #333; min-width: 160px; text-align: center; }
.meta-calendar__today-btn,
.meta-calendar__create-btn,
.meta-calendar__day-create { padding: 3px 10px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; color: #409eff; }
.meta-calendar__today-btn:hover,
.meta-calendar__create-btn:hover,
.meta-calendar__day-create:hover { background: #ecf5ff; }
.meta-calendar__mode-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
.meta-calendar__mode-select { padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-calendar__field-label { margin-left: auto; font-size: 12px; color: #999; }
.meta-calendar__change-btn { padding: 1px 6px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 11px; color: #409eff; margin-left: 4px; }
.meta-calendar__notice { margin: 8px 16px 0; padding: 6px 10px; border: 1px solid #fde68a; border-radius: 6px; background: #fffbeb; color: #92400e; font-size: 12px; line-height: 1.45; }
.meta-calendar__weekdays { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid #eee; }
.meta-calendar__weekday { padding: 6px 0; text-align: center; font-size: 12px; font-weight: 600; color: #999; }
.meta-calendar__grid { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
.meta-calendar__grid--week { min-height: 180px; }
.meta-calendar__cell { min-height: 80px; border: 1px solid #f0f0f0; padding: 4px 6px; cursor: pointer; transition: background 0.1s; }
.meta-calendar__cell:hover { background: #fafbfc; }
.meta-calendar__cell:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-calendar__cell--outside { background: #fafafa; }
.meta-calendar__cell--outside .meta-calendar__day-num { color: #ccc; }
.meta-calendar__cell--today { background: #ecf5ff; }
.meta-calendar__cell--today .meta-calendar__day-num { color: #409eff; font-weight: 700; }
.meta-calendar__cell--week { min-height: 120px; }
.meta-calendar__day-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px; margin-bottom: 2px; }
.meta-calendar__day-num { font-size: 12px; color: #666; margin-bottom: 2px; }
.meta-calendar__lunar { color: #8a5c2e; font-size: 10px; line-height: 1.25; white-space: nowrap; }
.meta-calendar__holidays,
.meta-calendar__day-calendar-meta { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 3px; }
.meta-calendar__holiday { display: inline-flex; align-items: center; max-width: 100%; padding: 1px 5px; border-radius: 999px; font-size: 10px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-calendar__holiday--rest { background: #ffe8e8; color: #9a1a1a; }
.meta-calendar__holiday--working { background: #e5f7ec; color: #15693a; }
/* Minimal override marker (PR1 scope C): dotted bottom-border + cursor:help so
 * the user notices a layered policy and the native title tooltip discloses the
 * full chain. Source coloring palette is intentionally deferred to PR2. */
.meta-calendar__holiday--overridden { border-bottom: 1px dotted currentColor; cursor: help; }
.meta-calendar__holiday--with-overlay::after { content: '·'; margin-left: 3px; opacity: 0.55; }
.meta-calendar__events { display: flex; flex-direction: column; gap: 2px; }
.meta-calendar__event { padding: 2px 4px; background: #409eff; color: #fff; border-radius: 3px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.meta-calendar__event:hover { background: #337ecc; }
.meta-calendar__event--attachment { background: #f8fafc; color: #334155; border: 1px solid #dbeafe; white-space: normal; }
.meta-calendar__event--attachment:hover { background: #eff6ff; }
.meta-calendar__event-copy { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.meta-calendar__event-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.meta-calendar__comment-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; padding: 2px 6px; border: 1px solid #bfdbfe; border-radius: 999px; background: #fff; cursor: pointer; color: #2563eb; }
.meta-calendar__comment-btn:hover { border-color: #60a5fa; background: #dbeafe; }
.meta-calendar__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-calendar__comment-btn--idle { border-color: #bfdbfe; background: #fff; color: #2563eb; }
.meta-calendar__field-comment-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 22px; padding: 0 5px; border: 1px solid #bfdbfe; border-radius: 999px; background: #fff; cursor: pointer; color: #2563eb; }
.meta-calendar__field-comment-btn:hover { border-color: #60a5fa; background: #dbeafe; }
.meta-calendar__field-comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-calendar__field-comment-btn--idle { border-color: #bfdbfe; background: #fff; color: #2563eb; }
.meta-calendar__event-attachments { pointer-events: none; }
.meta-calendar__event-attachments :deep(.meta-attachment-list__items) { gap: 4px; }
.meta-calendar__event-attachments :deep(.meta-attachment-list__card) { border-color: #bfdbfe; background: #fff; }
.meta-calendar__overflow { font-size: 10px; color: #999; padding: 1px 4px; }
.meta-calendar__day-view { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
.meta-calendar__day-panel { min-width: 240px; display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fbfdff; }
.meta-calendar__day-heading { font-size: 16px; font-weight: 600; color: #1f2937; }
.meta-calendar__day-meta { font-size: 12px; color: #64748b; }
.meta-calendar__day-list { flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 160px; }
.meta-calendar__day-event { padding: 10px 12px; border: 1px solid #dbeafe; border-radius: 8px; background: #eff6ff; color: #1d4ed8; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.meta-calendar__day-event--attachment { background: #f8fafc; color: #334155; }
.meta-calendar__day-event-attachments :deep(.meta-attachment-list__card) { border-color: #bfdbfe; background: #fff; }
.meta-calendar__empty-hint { color: #94a3b8; font-size: 13px; }
.meta-calendar__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
