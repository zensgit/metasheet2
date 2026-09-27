/**
 * 客户反馈 2026-09-24 #4c follow-up（日期时间显示），裁定见 PR #6074 — the surfaces PR #6083 listed as deferred.
 *
 * Rule under test (same as #6083): a date-time is a UTC instant shown in ONE business timezone (field zone →
 * instance business timezone → Asia/Shanghai), fixed 24-hour format, never the browser's zone / locale:
 *   1. calendar / timeline / Gantt put a dateTime record on the BUSINESS day its cell shows (calendar used the
 *      UTC day of the stored `…Z` text, timeline / Gantt the UTC day of the instant), and "today" is the
 *      business today; `date` fields (floating day, #3417) are untouched;
 *   2. grid group headers — already fixed by #6083 (its N5 test); nothing added here;
 *   3. history / audit / config-history / automation-log / notification / comment timestamps: business
 *      timezone, `YYYY-MM-DD HH:mm[:ss]` instead of `toLocaleString()` (browser zone, 12-hour under en-US);
 *   4. a record opened on its own (GET /records/:id) learns the business timezone from that response;
 *   5. a lookup of a dateTime field shows / exports the target column's wall clock, not the raw ISO.
 *
 * The business zone here is the owner's default, Asia/Shanghai. The instants are chosen so the Beijing day
 * differs from the UTC day (and from a New York browser's day), so a UTC-day regression fails on ANY host and a
 * browser-local regression fails in the TZ=America/New_York child runs at the bottom (out-of-process tsx probe
 * + the UI describe re-executed in child vitest processes — the #6083 pattern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'
import MetaGanttView from '../src/multitable/components/MetaGanttView.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaNotificationBell from '../src/multitable/components/MetaNotificationBell.vue'
import MetaAutomationLogViewer from '../src/multitable/components/MetaAutomationLogViewer.vue'
import MetaAutomationGroupDeliveryViewer from '../src/multitable/components/MetaAutomationGroupDeliveryViewer.vue'
import MetaAutomationPersonDeliveryViewer from '../src/multitable/components/MetaAutomationPersonDeliveryViewer.vue'
import ResetToPointPicker from '../src/multitable/components/ResetToPointPicker.vue'
import MetaCommentsDrawer from '../src/multitable/components/MetaCommentsDrawer.vue'
import SharedMetaCommentsPanel from '../src/shared/comments/components/MetaCommentsPanel.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import {
  businessTodayKey,
  dateTimeValueDayKey,
  dateTimeZoneHint,
  dayKeyInZone,
  formatBusinessTimestamp,
  getBusinessTimezone,
  resetBusinessTimezone,
  setBusinessTimezone,
} from '../src/multitable/utils/business-timezone'
import { dateTimeExportText, formatFieldDisplay, lookupDateTimeTexts, viewDayZone } from '../src/multitable/utils/field-display'
import {
  getLookupTargetField,
  loadLookupTargetFields,
  lookupTargetRefs,
  lookupTargetSignature,
  resetLookupTargetFields,
  setLookupTargetFields,
} from '../src/multitable/utils/lookup-target-fields'
import { configHistoryTime } from '../src/multitable/utils/meta-config-history-labels'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../../..')
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const PROBE_SCRIPT = path.resolve(TESTS_DIR, 'helpers/multitableDeferredSurfacesTzProbe.ts')

// 2026-09-24 01:00 北京时间: the UTC day is 09-23, a New York browser's day is 09-23.
const EARLY_MORNING = '2026-09-23T17:00:00.000Z'
// 2026-09-26 01:00 北京时间 (UTC day 09-25).
const LATER_EARLY_MORNING = '2026-09-25T17:00:00.000Z'
// 2026-09-25 00:30 北京时间: the UTC day (09-24) — what the old calendar bucketed by — is the day before.
const JUST_AFTER_MIDNIGHT = '2026-09-24T16:30:00.000Z'
// 2026-09-24 21:05:07 北京时间 — a 12-hour locale prints "9:05:07 PM".
const EVENING = '2026-09-24T13:05:07.000Z'
// "Now" for the "today" tests: 2026-09-24 01:30 in Beijing, still 2026-09-23 in UTC and in New York.
const NOW_BEIJING_NEXT_DAY = '2026-09-23T17:30:00.000Z'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function flushMacrotask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const mountedApps: Array<{ app: App; container: HTMLElement }> = []

function mount(render: () => ReturnType<typeof h>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render })
  app.mount(container)
  mountedApps.push({ app, container })
  return container
}

function unmountAll() {
  while (mountedApps.length) {
    const { app, container } = mountedApps.pop()!
    app.unmount()
    container.remove()
  }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------------------------------------

describe('deferred date-time surfaces — helpers', () => {
  beforeEach(() => {
    resetBusinessTimezone()
    resetLookupTargetFields()
  })
  afterEach(() => {
    resetBusinessTimezone()
    resetLookupTargetFields()
  })

  it('day keys are the business day of the instant, never the UTC day', () => {
    expect(dayKeyInZone(Date.parse(EARLY_MORNING), 'Asia/Shanghai')).toBe('2026-09-24')
    expect(dateTimeValueDayKey(EARLY_MORNING, 'Asia/Shanghai')).toBe('2026-09-24')
    expect(dateTimeValueDayKey(JUST_AFTER_MIDNIGHT, 'Asia/Shanghai')).toBe('2026-09-25')
    // A zone-less stored string is a business wall clock (the same rule as the cells).
    expect(dateTimeValueDayKey('2026-09-24 23:59', 'Asia/Shanghai')).toBe('2026-09-24')
    expect(dateTimeValueDayKey('not a date', 'Asia/Shanghai')).toBeNull()
    expect(dateTimeValueDayKey(null, 'Asia/Shanghai')).toBeNull()
    expect(businessTodayKey('Asia/Shanghai', Date.parse(NOW_BEIJING_NEXT_DAY))).toBe('2026-09-24')
    setBusinessTimezone('America/New_York')
    expect(businessTodayKey(undefined, Date.parse(NOW_BEIJING_NEXT_DAY))).toBe('2026-09-23')
  })

  it('viewDayZone: date-time-like fields get their zone; date / text fields keep the old day logic (null)', () => {
    expect(viewDayZone({ type: 'dateTime', property: { timezone: 'UTC' } })).toBe('Asia/Shanghai') // 'UTC' = unset
    expect(viewDayZone({ type: 'dateTime', property: { timezone: 'Asia/Tokyo' } })).toBe('Asia/Tokyo')
    expect(viewDayZone({ type: 'createdTime' })).toBe('Asia/Shanghai')
    expect(viewDayZone({ type: 'modifiedTime' })).toBe('Asia/Shanghai')
    expect(viewDayZone({ type: 'date' })).toBeNull()
    expect(viewDayZone({ type: 'string' })).toBeNull()
    expect(viewDayZone(null)).toBeNull()
  })

  it('formatBusinessTimestamp: business zone, 24-hour, minute / second / day precision, raw-safe', () => {
    expect(formatBusinessTimestamp(EVENING)).toBe('2026-09-24 21:05')
    expect(formatBusinessTimestamp(EVENING, { precision: 'second' })).toBe('2026-09-24 21:05:07')
    expect(formatBusinessTimestamp(EARLY_MORNING, { precision: 'day' })).toBe('2026-09-24')
    // PostgreSQL text form with an hour-only offset and microseconds.
    expect(formatBusinessTimestamp('2026-09-24 13:05:07.123456+00', { precision: 'second' })).toBe('2026-09-24 21:05:07')
    expect(formatBusinessTimestamp('2026-09-24 13:05-05', { precision: 'second' })).toBe('2026-09-25 02:05:00')
    // A bare date's `-24` is a day, not an hour-only offset: it reads as that business day.
    expect(formatBusinessTimestamp('2026-09-24', { precision: 'day' })).toBe('2026-09-24')
    expect(formatBusinessTimestamp('2026-09-24')).toBe('2026-09-24 00:00')
    expect(formatBusinessTimestamp('2026-09-24T13:05:07+08:00')).toBe('2026-09-24 13:05')
    expect(formatBusinessTimestamp(Date.parse(EVENING))).toBe('2026-09-24 21:05')
    expect(formatBusinessTimestamp(EVENING, { timeZone: 'Asia/Tokyo' })).toBe('2026-09-24 22:05')
    expect(formatBusinessTimestamp('legacy-time-unavailable')).toBeNull()
    expect(formatBusinessTimestamp('')).toBeNull()
    expect(formatBusinessTimestamp(null)).toBeNull()
    setBusinessTimezone('Asia/Kathmandu')
    expect(formatBusinessTimestamp(EVENING)).toBe('2026-09-24 18:50') // follows the server-provided zone
  })

  it('configHistoryTime: business zone to the second; the zone is named only when the browser reads another clock', () => {
    for (const isZh of [true, false]) {
      const hint = dateTimeZoneHint('Asia/Shanghai', isZh, new Date(EVENING))
      expect(configHistoryTime(EVENING, isZh)).toBe(hint ? `2026-09-24 21:05:07 ${hint}` : '2026-09-24 21:05:07')
    }
    expect(configHistoryTime('legacy-time-unavailable', true)).toBe('legacy-time-unavailable')
  })

  it('lookup of a dateTime: display + export use the target column wall clock; unknown targets stay raw', () => {
    const lookup = { id: 'fld_lk', name: 'Due', type: 'lookup', property: { targetFieldId: 'fld_due', foreignSheetId: 'sheet_b' } } as MetaField
    const value = [EARLY_MORNING, EVENING]
    // Before the target is known: raw (today's behaviour — never guessed from the value's shape).
    expect(formatFieldDisplay({ field: lookup, value })).toBe(`${EARLY_MORNING}, ${EVENING}`)
    expect(dateTimeExportText(lookup, value)).toBeNull()
    expect(lookupDateTimeTexts(lookup, value)).toBeNull()

    setLookupTargetFields({ fld_lk: { type: 'dateTime', property: { timezone: 'UTC' } } })
    expect(formatFieldDisplay({ field: lookup, value })).toBe('2026-09-24 01:00, 2026-09-24 21:05')
    expect(dateTimeExportText(lookup, value)).toBe('2026-09-24 01:00; 2026-09-24 21:05')
    // Junk inside the lookup keeps its raw text; empties are skipped; an all-empty lookup is the empty glyph.
    expect(formatFieldDisplay({ field: lookup, value: [EVENING, 'n/a', null, ''] })).toBe('2026-09-24 21:05, n/a')
    expect(formatFieldDisplay({ field: lookup, value: [] })).toBe('—')
    // The target's own zone rule applies (explicit non-UTC zone on the target field).
    setLookupTargetFields({ fld_lk: { type: 'dateTime', property: { timezone: 'Asia/Tokyo' } } })
    expect(formatFieldDisplay({ field: lookup, value: [EVENING] })).toBe('2026-09-24 22:05')
    // createdTime / modifiedTime targets: business zone.
    setLookupTargetFields({ fld_lk: { type: 'createdTime' } })
    expect(formatFieldDisplay({ field: lookup, value: [EVENING] })).toBe('2026-09-24 21:05')
    // A text target stays raw.
    setLookupTargetFields({ fld_lk: { type: 'string' } })
    expect(formatFieldDisplay({ field: lookup, value: [EVENING] })).toBe(EVENING)
    expect(dateTimeExportText(lookup, [EVENING])).toBeNull()
  })

  it('loadLookupTargetFields resolves each target through the read-gated field listing, once per foreign sheet', async () => {
    const fields = [
      { id: 'fld_link', name: 'Order', type: 'link', property: { foreignSheetId: 'sheet_orders' } },
      // foreignSheetId resolved through the link field
      { id: 'fld_lk_due', name: 'Due', type: 'lookup', property: { linkFieldId: 'fld_link', targetFieldId: 'fld_due' } },
      // explicit foreignSheetId
      { id: 'fld_lk_name', name: 'Name', type: 'lookup', property: { linkFieldId: 'fld_link', targetFieldId: 'fld_name', foreignSheetId: 'sheet_orders' } },
      // unreadable foreign sheet
      { id: 'fld_lk_secret', name: 'Secret', type: 'lookup', property: { targetFieldId: 'fld_x', foreignSheetId: 'sheet_denied' } },
    ] as MetaField[]
    expect(lookupTargetRefs(fields).map((ref) => `${ref.lookupFieldId}>${ref.foreignSheetId}.${ref.targetFieldId}`)).toEqual([
      'fld_lk_due>sheet_orders.fld_due',
      'fld_lk_name>sheet_orders.fld_name',
      'fld_lk_secret>sheet_denied.fld_x',
    ])
    expect(lookupTargetSignature(fields)).toBe('fld_lk_due>sheet_orders.fld_due|fld_lk_name>sheet_orders.fld_name|fld_lk_secret>sheet_denied.fld_x')
    expect(lookupTargetSignature(fields.slice(0, 1))).toBe('')

    const listFields = vi.fn(async (sheetId: string) => {
      if (sheetId === 'sheet_denied') throw new Error('403')
      return [
        { id: 'fld_due', name: 'Due', type: 'dateTime', property: { timezone: 'UTC' } },
        { id: 'fld_name', name: 'Name', type: 'string' },
      ] as MetaField[]
    })
    await loadLookupTargetFields(fields, listFields)
    expect(listFields).toHaveBeenCalledTimes(2) // sheet_orders once, sheet_denied once
    expect(getLookupTargetField('fld_lk_due')).toEqual({ type: 'dateTime', property: { timezone: 'UTC' } })
    expect(getLookupTargetField('fld_lk_name')).toEqual({ type: 'string' })
    expect(getLookupTargetField('fld_lk_secret')).toBeNull()
    expect(formatFieldDisplay({ field: fields[1], value: [EARLY_MORNING] })).toBe('2026-09-24 01:00')

    // The target field disappears from a sheet that WAS read → the stale answer is dropped (raw again).
    await loadLookupTargetFields(fields, async (sheetId) => {
      if (sheetId === 'sheet_denied') throw new Error('403')
      return [{ id: 'fld_name', name: 'Name', type: 'string' }] as MetaField[]
    })
    expect(getLookupTargetField('fld_lk_due')).toBeNull()
    expect(formatFieldDisplay({ field: fields[1], value: [EARLY_MORNING] })).toBe(EARLY_MORNING)
  })

  it('a record opened on its own adopts the businessTimezone of GET /records/:id; an older server keeps the zone', async () => {
    const bodies = [
      { ok: true, data: { sheet: { id: 's' }, fields: [], record: { id: 'r', version: 1, data: {} }, businessTimezone: 'Asia/Tokyo' } },
      { ok: true, data: { sheet: { id: 's' }, fields: [], record: { id: 'r', version: 1, data: {} } } },
    ]
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new MultitableApiClient({ fetchFn: fetchFn as unknown as typeof fetch })
    const field = { id: 'f', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField

    expect(formatFieldDisplay({ field, value: EARLY_MORNING })).toBe('2026-09-24 01:00')
    await client.getRecord('r')
    expect(getBusinessTimezone()).toBe('Asia/Tokyo')
    expect(formatFieldDisplay({ field, value: EARLY_MORNING })).toBe('2026-09-24 02:00')
    await client.getRecord('r')
    expect(getBusinessTimezone()).toBe('Asia/Tokyo')
  })
})

// ---------------------------------------------------------------------------------------------------------
// UI surfaces. The S6-style child runs below re-execute THIS describe under TZ=UTC and TZ=America/New_York:
// keep it free of anything that depends on the host zone other than through the code under test.
// ---------------------------------------------------------------------------------------------------------

const DT_FIELDS: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_start', name: 'Start', type: 'dateTime', property: { timezone: 'UTC' } },
  { id: 'fld_end', name: 'End', type: 'dateTime', property: { timezone: 'UTC' } },
  { id: 'fld_day', name: 'Day', type: 'date' },
]

function row(id: string, data: Record<string, unknown>, version = 1): MetaRecord {
  return { id, version, data } as MetaRecord
}

function calendarCellDayOf(container: HTMLElement, title: string): string | null {
  for (const cell of Array.from(container.querySelectorAll('.meta-calendar__cell'))) {
    if (cell.classList.contains('meta-calendar__cell--outside')) continue
    const titles = Array.from(cell.querySelectorAll('.meta-calendar__event')).map((el) => el.textContent ?? '')
    if (titles.some((text) => text.includes(title))) return cell.querySelector('.meta-calendar__day-num')?.textContent?.trim() ?? null
  }
  return null
}

describe('deferred date-time surfaces — UI surfaces (TZ-independent)', () => {
  beforeEach(() => {
    resetBusinessTimezone()
    resetLookupTargetFields()
    useLocale().setLocale('en')
  })
  afterEach(() => {
    unmountAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetBusinessTimezone()
    resetLookupTargetFields()
    useLocale().setLocale('en')
    document.body.innerHTML = ''
  })

  it('calendar (month): a dateTime record lands on the business day its cell shows; a date record is untouched', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T04:00:00.000Z'))
    const container = mount(() => h(MetaCalendarView, {
      rows: [
        row('rec_early', { fld_title: 'Early shift', fld_start: EARLY_MORNING }),
        row('rec_midnight', { fld_title: 'Midnight run', fld_start: JUST_AFTER_MIDNIGHT }),
        row('rec_plain', { fld_title: 'Plain day', fld_day: '2026-09-24' }),
      ],
      fields: DT_FIELDS,
      loading: false,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
    }))
    await flushUi()
    expect(calendarCellDayOf(container, 'Early shift')).toBe('24') // UTC / New York day: 23
    expect(calendarCellDayOf(container, 'Midnight run')).toBe('25') // UTC day (old bucketing): 24

    unmountAll()
    const dateContainer = mount(() => h(MetaCalendarView, {
      rows: [row('rec_plain', { fld_title: 'Plain day', fld_day: '2026-09-24' })],
      fields: DT_FIELDS,
      loading: false,
      viewConfig: { dateFieldId: 'fld_day', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
    }))
    await flushUi()
    expect(calendarCellDayOf(dateContainer, 'Plain day')).toBe('24') // floating day, as written
  })

  it('calendar: the end field is bucketed by its own business day too', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T04:00:00.000Z'))
    const container = mount(() => h(MetaCalendarView, {
      rows: [row('rec_span', { fld_title: 'Span', fld_start: EARLY_MORNING, fld_end: LATER_EARLY_MORNING })],
      fields: DT_FIELDS,
      loading: false,
      viewConfig: { dateFieldId: 'fld_start', endDateFieldId: 'fld_end', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
    }))
    await flushUi()
    const days = Array.from(container.querySelectorAll('.meta-calendar__cell'))
      .filter((cell) => !cell.classList.contains('meta-calendar__cell--outside') && (cell.textContent ?? '').includes('Span'))
      .map((cell) => cell.querySelector('.meta-calendar__day-num')?.textContent?.trim())
    expect(days).toEqual(['24', '25', '26']) // UTC days would be 23-25
  })

  it('calendar: "today" is the business today — highlight, day view and quick-create', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_BEIJING_NEXT_DAY))
    const createSpy = vi.fn()
    const container = mount(() => h(MetaCalendarView, {
      rows: [row('rec_early', { fld_title: 'Early shift', fld_start: EARLY_MORNING })],
      fields: DT_FIELDS,
      loading: false,
      canCreate: true,
      // endDateFieldId explicit: left out, resolveCalendarViewConfig defaults it to the first string field
      // (fld_title), which quick-create would then seed too.
      viewConfig: { dateFieldId: 'fld_start', endDateFieldId: 'fld_end', titleFieldId: 'fld_title', defaultView: 'day', weekStartsOn: 0 },
      onCreateRecord: createSpy,
    }))
    await flushUi()
    // Day view opens on the business today (09-24) and lists the 01:00 record of that day.
    expect(Array.from(container.querySelectorAll('.meta-calendar__day-event')).map((el) => el.textContent ?? '').join('|')).toContain('Early shift')
    ;(container.querySelector('.meta-calendar__create-btn') as HTMLButtonElement).click()
    expect(createSpy).toHaveBeenCalledWith({ fld_start: '2026-09-24', fld_end: '2026-09-24' })

    unmountAll()
    const month = mount(() => h(MetaCalendarView, {
      rows: [],
      fields: DT_FIELDS,
      loading: false,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
    }))
    await flushUi()
    const today = Array.from(month.querySelectorAll('.meta-calendar__cell--today'))
    expect(today).toHaveLength(1)
    expect(today[0]!.querySelector('.meta-calendar__day-num')?.textContent?.trim()).toBe('24')
  })

  it('timeline: bars carry the business days; a drop writes the business day it lands on; quick-create seeds the business today', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_BEIJING_NEXT_DAY))
    const patchSpy = vi.fn()
    const createSpy = vi.fn()
    const container = mount(() => h(MetaTimelineView, {
      rows: [row('rec_1', { fld_title: 'Rollout', fld_start: EARLY_MORNING, fld_end: LATER_EARLY_MORNING }, 3)],
      fields: DT_FIELDS,
      loading: false,
      canEdit: true,
      canCreate: true,
      viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_title', zoom: 'week' },
      onPatchDates: patchSpy,
      onCreateRecord: createSpy,
    }))
    await flushUi()
    const bar = container.querySelector('.meta-timeline__bar') as HTMLElement
    expect(bar.getAttribute('title')).toBe('2026-09-24 → 2026-09-26') // UTC days: 09-23 → 09-25

    const barArea = container.querySelector('.meta-timeline__bar-area') as HTMLElement
    Object.defineProperty(barArea, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 200, top: 0, height: 24, right: 200, bottom: 24 }),
    })
    // Range = [start − 2.4h, end + 2.4h]; x=20/200 → 2026-09-23T19:52:48Z = 09-24 03:52 in Beijing.
    bar.dispatchEvent(new Event('dragstart', { bubbles: true }))
    barArea.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: 20 }))
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0]![0]).toEqual({
      recordId: 'rec_1',
      version: 3,
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      startValue: '2026-09-24',
      endValue: '2026-09-26',
    })

    ;(container.querySelector('.meta-timeline__create-btn') as HTMLElement).click()
    expect(createSpy).toHaveBeenCalledWith({ fld_start: '2026-09-24', fld_end: '2026-09-24' })
  })

  it('timeline: date fields keep their existing day math (floating day)', async () => {
    const container = mount(() => h(MetaTimelineView, {
      rows: [row('rec_1', { fld_title: 'Plain', fld_day: '2026-09-24' })],
      fields: DT_FIELDS,
      loading: false,
      viewConfig: { startFieldId: 'fld_day', endFieldId: 'fld_day', labelFieldId: 'fld_title', zoom: 'week' },
    }))
    await flushUi()
    expect((container.querySelector('.meta-timeline__bar') as HTMLElement).getAttribute('title')).toBe('2026-09-24 → 2026-09-24')
  })

  it('gantt: task dates, resize value, dateTime group label and quick-create use the business day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_BEIJING_NEXT_DAY))
    const patchSpy = vi.fn()
    const createSpy = vi.fn()
    const container = mount(() => h(MetaGanttView, {
      loading: false,
      canEdit: true,
      canCreate: true,
      fields: DT_FIELDS,
      rows: [row('rec_build', { fld_title: 'Build', fld_start: EARLY_MORNING, fld_end: LATER_EARLY_MORNING }, 7)],
      viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end', titleFieldId: 'fld_title', groupFieldId: 'fld_start' },
      groupInfo: { fieldId: 'fld_start' },
      onPatchDates: patchSpy,
      onCreateRecord: createSpy,
    }))
    await flushUi()
    const small = container.querySelector('.meta-gantt__row small')?.textContent ?? ''
    expect(small).toContain('2026-09-24')
    expect(small).toContain('2026-09-26')
    expect(small).not.toContain('2026-09-23')
    // A dateTime group shows the wall clock its cells show, not the raw stored ISO.
    expect(container.querySelector('.meta-gantt__group')?.textContent?.trim()).toBe('2026-09-24 01:00')

    const barArea = container.querySelector('.meta-gantt__bar-area') as HTMLElement
    const endHandle = container.querySelector('.meta-gantt__resize-handle--end') as HTMLElement
    Object.defineProperty(barArea, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 300, top: 0, height: 40, right: 300, bottom: 40 }),
    })
    // Range = [start − 1d, end + 1d]; x=300/300 → end + 1d = 2026-09-26T17:00Z = 09-27 01:00 in Beijing.
    endHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 150 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300 }))
    await flushUi()
    expect(patchSpy).toHaveBeenCalledWith({
      recordId: 'rec_build',
      version: 7,
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      startValue: '2026-09-24', // unchanged start, compared as the business day
      endValue: '2026-09-27', // UTC day: 09-26
    })

    ;(container.querySelector('.meta-gantt__create') as HTMLElement).click()
    expect(createSpy).toHaveBeenCalledWith({ fld_start: '2026-09-24', fld_end: '2026-09-24' })
  })

  it('lookup cell: the grid renderer shows the target column wall clock once the target is known', async () => {
    const lookup = { id: 'fld_lk', name: 'Due', type: 'lookup', property: { targetFieldId: 'fld_due', foreignSheetId: 'sheet_b' } } as MetaField
    const container = mount(() => h(MetaCellRenderer, { field: lookup, value: [EARLY_MORNING, EVENING] }))
    await flushUi()
    expect(container.textContent?.trim()).toBe(`${EARLY_MORNING}, ${EVENING}`)
    setLookupTargetFields({ fld_lk: { type: 'dateTime', property: { timezone: 'UTC' } } })
    await flushUi()
    expect(container.textContent?.trim()).toBe('2026-09-24 01:00, 2026-09-24 21:05') // reactive
  })

  it('notification bell: business-zone 24-hour time', async () => {
    const apiClient = {
      listRecordSubscriptionNotifications: vi.fn(async () => [{ id: 'n1', sheetId: 's1', recordId: 'rec_1', userId: 'u1', eventType: 'record.updated', actorId: null, revisionId: null, commentId: null, message: null, createdAt: EVENING, readAt: null }]),
      getRecordSubscriptionUnreadCount: vi.fn(async () => 1),
      markRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
      markAllRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    }
    const container = mount(() => h(MetaNotificationBell, { apiClient: apiClient as never }))
    await flushMacrotask()
    ;(container.querySelector('[data-test="notification-bell-btn"]') as HTMLButtonElement).click()
    await flushMacrotask()
    expect(container.querySelector('.meta-notif-bell__time')?.textContent?.trim()).toBe('2026-09-24 21:05')
  })

  it('automation log + delivery viewers: business-zone 24-hour time to the second', async () => {
    const logClient = {
      getAutomationLogs: async () => [{ id: 'exec-1', ruleId: 'rule-1', status: 'success', triggeredBy: 'event', triggeredAt: EVENING, duration: 1, steps: [] }],
      getAutomationStats: async () => ({ total: 1, success: 1, failed: 0, skipped: 0, avgDuration: 1 }),
    }
    const logs = mount(() => h(MetaAutomationLogViewer, { visible: true, sheetId: 's', ruleId: 'rule-1', client: logClient as never }))
    await flushMacrotask()
    expect(logs.querySelector('[data-log-id="exec-1"] .meta-log-viewer__log-time')?.textContent?.trim()).toBe('2026-09-24 21:05:07')

    const group = mount(() => h(MetaAutomationGroupDeliveryViewer, {
      visible: true, sheetId: 's', ruleId: 'rule-1',
      client: { getAutomationDingTalkGroupDeliveries: async () => [{ id: 'g1', destinationId: 'd1', destinationName: 'Ops', sourceType: 'automation', subject: 'x', content: 'y', success: true, createdAt: EVENING }] } as never,
    }))
    const person = mount(() => h(MetaAutomationPersonDeliveryViewer, {
      visible: true, sheetId: 's', ruleId: 'rule-1',
      client: { getAutomationDingTalkPersonDeliveries: async () => [{ id: 'p1', localUserId: 'u1', localUserLabel: 'Lin', localUserIsActive: true, sourceType: 'automation', subject: 'x', content: 'y', success: true, status: 'success', createdAt: EVENING }] } as never,
    }))
    await flushMacrotask()
    expect(group.querySelector('.meta-group-delivery__time')?.textContent?.trim()).toBe('2026-09-24 21:05:07')
    expect(person.querySelector('.meta-person-delivery__time')?.textContent?.trim()).toBe('2026-09-24 21:05:07')
  })

  it('reset-to-point picker: batch label and target line in the business zone, to the second', async () => {
    const batch = {
      batchId: 'batch_1', sheetId: 'sheet_1', actorId: 'u1', actorName: 'Ada', source: 'rest', action: 'update',
      createdAt: EVENING, visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1, provenanceQuality: 'stamped',
    }
    // Props hoisted out of the render function: the picker reloads when `listHistoryEvents` changes identity.
    const pickerProps = {
      pitResetEnabled: true,
      baseId: 'base_1',
      sheetId: 'sheet_1',
      listHistoryEvents: vi.fn(async () => ({ batches: [batch], total: 1, nextCursor: null, searchTruncated: false })),
      resetPreview: vi.fn(async () => ({ strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [], previewIdentity: 't' })),
      resetExecute: vi.fn(async () => ({ strategy: 'reset', revertedCount: 0, deletedRecordIds: [] })),
    }
    const container = mount(() => h(ResetToPointPicker, pickerProps))
    for (let i = 0; i < 50 && !container.querySelector('[data-test="reset-picker-history-select"] option[value="batch_1"]'); i += 1) await flushUi(1)
    const option = container.querySelector('[data-test="reset-picker-history-select"] option[value="batch_1"]')
    expect(option?.textContent?.trim().startsWith('2026-09-24 21:05:07 - ')).toBe(true)
    const select = container.querySelector('[data-test="reset-picker-history-select"]') as HTMLSelectElement
    select.value = 'batch_1'
    select.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container.querySelector('[data-test="reset-picker-target"] strong')?.textContent?.trim()).toBe('2026-09-24 21:05:07')
  })

  it('comments: the multitable host passes the business-zone formatter; the shared panel alone keeps toLocaleString', async () => {
    const comment = {
      id: 'c1', spreadsheetId: 'sheet_1', rowId: 'row_1', targetFieldId: null, mentions: [], authorId: 'u1',
      authorName: 'Amy', content: 'hello', resolved: false, createdAt: EVENING,
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: defineComponent({ render: () => h('div') }) },
        { path: '/multitable/comments/inbox', name: 'multitable-comment-inbox', component: defineComponent({ render: () => h('div') }) },
      ],
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(MetaCommentsDrawer, {
        visible: true, comments: [comment] as never, loading: false, canComment: false, canResolve: false, draft: '',
        onResolve: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(), onSubmit: vi.fn(),
      }),
    })
    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    mountedApps.push({ app, container })
    await flushUi()
    expect(container.querySelector('.meta-comments-drawer__time')?.textContent?.trim()).toBe('2026-09-24 21:05')

    // The approval host passes no formatter: byte-identical browser-local text (approvals are not in scope).
    const shared = mount(() => h(SharedMetaCommentsPanel, {
      comments: [comment] as never, loading: false, canComment: false, canResolve: false, draft: '',
    }))
    await flushUi()
    expect(shared.querySelector('.meta-comments-drawer__time')?.textContent?.trim()).toBe(new Date(EVENING).toLocaleString())
  })
})

// ---------------------------------------------------------------------------------------------------------
// Out-of-process: a different "browser" zone must not change anything.
// ---------------------------------------------------------------------------------------------------------

interface ProbeResult {
  tzEnv: string | null
  resolvedTimeZone: string
  offsetMinutes: number
  businessTimezone: string
  viewDayZone: string | null
  calendarDay: string | null
  calendarDayEvening: string | null
  businessToday: string
  timestampMinute: string | null
  timestampSecond: string | null
  timestampDay: string | null
  timestampPgText: string | null
  historyTimeText: string
  lookupDisplay: string
  lookupExport: string | null
  oldUtcDay: string
  oldBrowserDay: string
  oldTimestamp: string
}

const PROBE_TEST_TIMEOUT_MS = 120_000

interface NodeRun { stdout: string; stderr: string; error: Error | null }

/**
 * Run `node <args>` in a child process WITHOUT blocking this worker's event loop. `execFileSync` would freeze
 * the worker for the whole child run, and a child that takes longer than vitest's worker RPC timeout (slow /
 * loaded runner) then surfaces as an unhandled "Timeout calling onTaskUpdate" error — a red run with every
 * assertion green. The async form keeps the worker answering while it waits.
 */
function runNode(args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string }): Promise<NodeRun> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
    child.stdin?.end()
  })
}

async function runProbe(tz: string): Promise<ProbeResult> {
  const run = await runNode([TSX_CLI, PROBE_SCRIPT], { env: { ...process.env, TZ: tz }, timeout: 100_000 })
  if (run.error) throw new Error(`probe (TZ=${tz}) failed: ${run.error.message}\n${run.stderr.slice(-2000)}`)
  return JSON.parse(run.stdout) as ProbeResult
}

describe('deferred date-time surfaces — independent of the browser zone (out-of-process probes)', { timeout: PROBE_TEST_TIMEOUT_MS }, () => {
  const expectedBrowserOffset: Record<string, number> = { 'America/New_York': 240, UTC: 0, 'Asia/Shanghai': -480 }
  const zones = Object.keys(expectedBrowserOffset)
  const results = new Map<string, ProbeResult>()

  it.skipIf(process.env.META_BUSINESS_TZ_CHILD === '1').each(zones)('under TZ=%s the day keys, timestamps and lookup texts are the Beijing ones', async (tz) => {
    const r = await runProbe(tz)
    results.set(tz, r)
    expect(r.tzEnv).toBe(tz)
    expect(r.offsetMinutes).toBe(expectedBrowserOffset[tz])
    expect(r.businessTimezone).toBe('Asia/Shanghai')
    expect(r.viewDayZone).toBe('Asia/Shanghai')
    expect(r.calendarDay).toBe('2026-09-24')
    expect(r.calendarDayEvening).toBe('2026-09-24')
    expect(r.businessToday).toBe('2026-09-24')
    expect(r.timestampMinute).toBe('2026-09-24 21:05')
    expect(r.timestampSecond).toBe('2026-09-24 21:05:07')
    expect(r.timestampDay).toBe('2026-09-24')
    expect(r.timestampPgText).toBe('2026-09-24 21:05:07')
    expect(r.historyTimeText).toBe('2026-09-24 21:05:07')
    expect(r.lookupDisplay).toBe('2026-09-24 01:00, 2026-09-24 21:05')
    expect(r.lookupExport).toBe('2026-09-24 01:00; 2026-09-24 21:05')
  })

  it.skipIf(process.env.META_BUSINESS_TZ_CHILD === '1')('negative control: the OLD code diverges across the same zones — the probe can see the bug', async () => {
    for (const tz of zones) if (!results.has(tz)) results.set(tz, await runProbe(tz))
    const ny = results.get('America/New_York')!
    const utc = results.get('UTC')!
    const sh = results.get('Asia/Shanghai')!
    expect(ny.oldUtcDay).toBe('2026-09-23') // the Gantt / timeline UTC day
    expect(ny.oldBrowserDay).toBe('2026-09-23') // a New York browser's day
    expect(utc.oldBrowserDay).toBe('2026-09-23')
    expect(sh.oldBrowserDay).toBe('2026-09-24')
    // toLocaleString under en-US: 12-hour, browser zone — 13:05Z is 9:05:07 AM in New York, not 21:05.
    expect(ny.oldTimestamp).toMatch(/AM$/)
    expect(ny.oldTimestamp).not.toContain('21:05')
    expect(sh.oldTimestamp).toMatch(/PM$/) // even a Beijing browser got 12-hour text under en-US
    expect(ny.oldTimestamp).not.toBe(sh.oldTimestamp)
  })
})

describe('deferred UI surfaces under a foreign process zone (child vitest runs)', { timeout: 300_000 }, () => {
  const VITEST_ENTRY = path.resolve(TESTS_DIR, '../node_modules/vitest/vitest.mjs')
  const SPEC = path.relative(path.resolve(TESTS_DIR, '..'), fileURLToPath(import.meta.url))
  interface ChildSummary { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number }

  async function runChild(tz: string): Promise<ChildSummary> {
    // `-t` selects ONLY the "UI surfaces (TZ-independent)" describe above; META_BUSINESS_TZ_CHILD stops the
    // child from spawning grandchildren. A failing child exits non-zero, so its stdout is read either way.
    const run = await runNode([VITEST_ENTRY, 'run', SPEC, '-t', 'deferred date-time surfaces — UI surfaces \\(TZ-independent\\)', '--reporter=json'], {
      cwd: path.resolve(TESTS_DIR, '..'),
      env: { ...process.env, TZ: tz, META_BUSINESS_TZ_CHILD: '1', CI: process.env.CI ?? '1' },
      timeout: 280_000,
    })
    const stdout = run.stdout
    if (!stdout.includes('"numTotalTests"')) {
      throw new Error(`child vitest (TZ=${tz}) produced no JSON summary: ${run.error?.message ?? ''}\n${run.stderr.slice(-2000)}`)
    }
    const start = stdout.indexOf('{"numTotalTestSuites"')
    const json = JSON.parse(stdout.slice(start === -1 ? stdout.indexOf('{') : start)) as ChildSummary & { testResults?: Array<{ assertionResults?: Array<{ status: string; fullName: string; failureMessages?: string[] }> }> }
    if (json.numFailedTests > 0) {
      const failures = (json.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).filter((t) => t.status === 'failed').map((t) => `${t.fullName}: ${(t.failureMessages ?? []).join(' ').slice(0, 400)}`))
      throw new Error(`child vitest (TZ=${tz}) failed ${json.numFailedTests} test(s):\n${failures.join('\n')}`)
    }
    return json
  }

  it.skipIf(process.env.META_BUSINESS_TZ_CHILD === '1').each(['UTC', 'America/New_York'])(
    'calendar / timeline / Gantt / lookup / timestamp surfaces pass with the process (browser) zone forced to %s',
    async (tz) => {
      const summary = await runChild(tz)
      expect(summary.numFailedTests).toBe(0)
      // The UI-surfaces describe holds 11 tests; `-t` leaves the rest skipped.
      expect(summary.numPassedTests).toBeGreaterThanOrEqual(11)
    },
  )
})
