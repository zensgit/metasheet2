/**
 * 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074.
 *
 * Rule under test: date-times are STORED as UTC instants (unchanged) but DISPLAYED and PARSED in ONE
 * business timezone — `field.property.timezone` when explicitly set to a non-UTC zone, else the server's
 * instance business timezone, else Asia/Shanghai — in a fixed `YYYY-MM-DD HH:mm` 24-hour format. The
 * browser's zone and locale must not matter: a Beijing 09:00 is stored as 01:00Z and shown as 09:00 on a
 * laptop in New York, in UTC, or anywhere else.
 *
 * Two layers:
 *   1. OUT-OF-PROCESS probes (tests/helpers/multitableBusinessTzProbe.ts) spawned with an explicit `TZ`:
 *      the only reliable way to hand the code a different "browser" zone (mutating process.env.TZ inside
 *      a running vitest worker is not reliable — dateOnlyTzProbe.ts / GATE-5047 P2-1). These make the
 *      suite discriminate on ANY host, including a UTC CI runner where a browser-local regression would
 *      otherwise look correct for some zones.
 *   2. In-worker tests of the helpers and of every editor/display surface. Where they need a zone the
 *      host cannot be in, they use a business zone with an odd offset (Asia/Kathmandu, UTC+05:45), so a
 *      reverted browser-local parse/format can never coincide with the expected value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaDateTimePicker from '../src/multitable/components/cells/MetaDateTimePicker.vue'
import MetaFieldHeader from '../src/multitable/components/MetaFieldHeader.vue'
import MetaFilterConditionRow from '../src/multitable/components/MetaFilterConditionRow.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { buildImportedRecords } from '../src/multitable/import/delimited'
import { normalizeXlsxDateCells, parseXlsxBuffer } from '../src/multitable/import/xlsx-mapping'
import {
  DEFAULT_AUTOMATION_BUSINESS_TIMEZONE,
  automationBusinessTimezone,
  effectiveTriggerTimezone,
  isUtcTriggerTimezone,
  triggerTimezoneForSave,
} from '../src/multitable/utils/automation-trigger-timezone'
import * as XLSX from 'xlsx'
import {
  DEFAULT_BUSINESS_TIMEZONE,
  browserTimezoneDiffers,
  businessTimezoneLabel,
  calendarDayFromText,
  dateTimeZoneHint,
  getBusinessTimezone,
  normalizeDateTimeInput,
  parseDateTimeInput,
  parseDateTimeTextToUtcMs,
  pickerDateForValue,
  resetBusinessTimezone,
  resolveDateTimeTimezone,
  setBusinessTimezone,
  utcMsFromWallClock,
  valueForPickerDate,
  wallClockToUtcMs,
} from '../src/multitable/utils/business-timezone'
import {
  dateTimeExportText,
  dateTimeInputValue,
  dateTimeValueFromInput,
  formatFieldDisplay,
} from '../src/multitable/utils/field-display'
import type { MetaField } from '../src/multitable/types'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../../..')
// tsx's CLI entry run through THIS node binary: portable (node_modules/.bin/tsx is a shell shim that
// execFileSync cannot start on Windows).
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const PROBE_SCRIPT = path.resolve(TESTS_DIR, 'helpers/multitableBusinessTzProbe.ts')

interface ProbeResult {
  tzEnv: string | null
  resolvedTimeZone: string
  offsetMinutes: number
  businessTimezone: string
  display: string
  displayBareField: string
  displayAfternoon: string
  displayMidnight: string
  displayCreatedTime: string
  displayModifiedTime: string
  inputValue: string
  parsed: string | null
  parsedT: string | null
  roundTrip: string | null
  hintZh: string
  hintEn: string
  oldInputValue: string
  oldParsed: string
  oldCreatedTime: string
}

// Each probe is a cold tsx child process (~1s locally, slower on a cold CI runner); the default 5s test
// timeout would turn runner slowness into a false red, so the probe block gets the spawn's own bound.
const PROBE_TEST_TIMEOUT_MS = 60_000

function runProbe(tz: string): ProbeResult {
  const stdout = execFileSync(process.execPath, [TSX_CLI, PROBE_SCRIPT], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return JSON.parse(stdout) as ProbeResult
}

const STORED = '2026-09-24T01:00:00.000Z' // 2026-09-24 09:00 北京时间

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(render: () => ReturnType<typeof h>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render })
  app.mount(container)
  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

function typeInto(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('business timezone — independent of the browser zone (out-of-process probes)', { timeout: PROBE_TEST_TIMEOUT_MS }, () => {
  // getTimezoneOffset() of the probe process at 2026-09-24T01:00Z (minutes WEST of UTC).
  const expectedBrowserOffset: Record<string, number> = {
    'America/New_York': 240,
    UTC: 0,
    'Asia/Shanghai': -480,
    'Asia/Kolkata': -330,
  }
  const zones = Object.keys(expectedBrowserOffset)
  const results = new Map<string, ProbeResult>()

  it.each(zones)('under TZ=%s a Beijing 09:00 shows, edits and parses as 09:00 ↔ 01:00Z', (tz) => {
    const r = runProbe(tz)
    results.set(tz, r)
    // The probe really ran in that zone (otherwise nothing below would mean anything). Compared by
    // offset: ICU may canonicalise the id (Asia/Kolkata → Asia/Calcutta).
    expect(r.tzEnv).toBe(tz)
    expect(r.offsetMinutes).toBe(expectedBrowserOffset[tz])
    expect(r.businessTimezone).toBe('Asia/Shanghai')
    expect(r.display).toBe('2026-09-24 09:00')
    expect(r.displayBareField).toBe('2026-09-24 09:00')
    expect(r.displayAfternoon).toBe('2026-09-24 21:05') // 24-hour, never "09:05 PM"
    expect(r.displayMidnight).toBe('2026-09-24 00:00') // midnight is 00, never 24
    expect(r.displayCreatedTime).toBe('2026-09-24 09:00') // system timestamps: same zone, same format
    expect(r.displayModifiedTime).toBe('2026-09-24 23:59')
    expect(r.inputValue).toBe('2026-09-24 09:00')
    expect(r.parsed).toBe(STORED)
    expect(r.parsedT).toBe(STORED)
    expect(r.roundTrip).toBe(STORED)
  })

  it('every browser zone produces byte-identical output (only the zone-hint and the old-path control may differ)', () => {
    for (const tz of zones) if (!results.has(tz)) results.set(tz, runProbe(tz))
    const strip = (r: ProbeResult) => {
      const { tzEnv: _a, resolvedTimeZone: _b, offsetMinutes: _c, hintZh: _d, hintEn: _e, oldInputValue: _f, oldParsed: _g, oldCreatedTime: _h, ...rest } = r
      return rest
    }
    const first = strip(results.get(zones[0])!)
    for (const tz of zones.slice(1)) expect(strip(results.get(tz)!)).toEqual(first)
  })

  it('shows the 北京时间 hint only when the browser reads a different clock than Beijing', () => {
    const ny = results.get('America/New_York') ?? runProbe('America/New_York')
    const utc = results.get('UTC') ?? runProbe('UTC')
    const sh = results.get('Asia/Shanghai') ?? runProbe('Asia/Shanghai')
    expect(ny.hintZh).toBe('北京时间')
    expect(ny.hintEn).toBe('Beijing time')
    expect(utc.hintZh).toBe('北京时间')
    expect(sh.hintZh).toBe('')
    expect(sh.hintEn).toBe('')
  })

  it('negative control: the OLD browser-local helpers DO diverge across the same zones — the probe can see the bug', () => {
    const ny = results.get('America/New_York') ?? runProbe('America/New_York')
    const utc = results.get('UTC') ?? runProbe('UTC')
    const sh = results.get('Asia/Shanghai') ?? runProbe('Asia/Shanghai')
    expect(ny.oldInputValue).toBe('2026-09-23T21:00')
    expect(utc.oldInputValue).toBe('2026-09-24T01:00') // the reported symptom: typed 09:00, shown 01:00
    expect(sh.oldInputValue).toBe('2026-09-24T09:00')
    expect(ny.oldParsed).toBe('2026-09-24T13:00:00.000Z')
    expect(utc.oldParsed).toBe('2026-09-24T09:00:00.000Z')
    expect(sh.oldParsed).toBe(STORED)
    expect(ny.oldCreatedTime).toMatch(/PM$/) // 12-hour under an en-US locale
  })
})

describe('business timezone — helpers', () => {
  afterEach(() => {
    resetBusinessTimezone()
    vi.restoreAllMocks()
  })

  it('defaults to Asia/Shanghai and adopts only a valid server-provided zone', () => {
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe('Asia/Shanghai')
    expect(getBusinessTimezone()).toBe('Asia/Shanghai')
    expect(setBusinessTimezone('Asia/Tokyo')).toBe(true)
    expect(getBusinessTimezone()).toBe('Asia/Tokyo')
    expect(setBusinessTimezone('Not/AZone')).toBe(false)
    expect(setBusinessTimezone(undefined)).toBe(false)
    expect(setBusinessTimezone('')).toBe(false)
    expect(setBusinessTimezone(42)).toBe(false)
    expect(getBusinessTimezone()).toBe('Asia/Tokyo') // junk never clobbers the last good value
  })

  it('field zone: an explicit non-UTC property.timezone wins; absent / legacy "UTC" / invalid → business zone', () => {
    setBusinessTimezone('Asia/Kathmandu')
    expect(resolveDateTimeTimezone({ timezone: 'America/New_York' })).toBe('America/New_York')
    expect(resolveDateTimeTimezone({ timezone: ' Europe/Berlin ' })).toBe('Europe/Berlin')
    expect(resolveDateTimeTimezone({ timezone: 'Etc/UTC' })).toBe('Etc/UTC')
    // The backend sanitizer stamps 'UTC' on every zone-less dateTime field — it is the "unset" marker.
    expect(resolveDateTimeTimezone({ timezone: 'UTC' })).toBe('Asia/Kathmandu')
    expect(resolveDateTimeTimezone({ timezone: 'Invalid/Zone' })).toBe('Asia/Kathmandu')
    expect(resolveDateTimeTimezone({})).toBe('Asia/Kathmandu')
    expect(resolveDateTimeTimezone(null)).toBe('Asia/Kathmandu')
    expect(resolveDateTimeTimezone(undefined)).toBe('Asia/Kathmandu')
  })

  it('displays in the business zone with a fixed 24-hour format (odd-offset zone: cannot coincide with the host)', () => {
    setBusinessTimezone('Asia/Kathmandu') // UTC+05:45
    const field = { id: 'f', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
    expect(formatFieldDisplay({ field, value: STORED })).toBe('2026-09-24 06:45')
    expect(formatFieldDisplay({ field, value: '2026-09-24T12:30:00.000Z' })).toBe('2026-09-24 18:15')
    expect(formatFieldDisplay({ field, value: '2026-09-23T18:15:00.000Z' })).toBe('2026-09-24 00:00')
    const created = { id: 'c', name: 'Created', type: 'createdTime' } as MetaField
    const modified = { id: 'm', name: 'Modified', type: 'modifiedTime' } as MetaField
    expect(formatFieldDisplay({ field: created, value: STORED })).toBe('2026-09-24 06:45')
    expect(formatFieldDisplay({ field: modified, value: STORED })).toBe('2026-09-24 06:45')
    // An explicit field zone overrides the business zone for display.
    const tokyoField = { id: 't', name: 'When', type: 'dateTime', property: { timezone: 'Asia/Tokyo' } } as MetaField
    expect(formatFieldDisplay({ field: tokyoField, value: STORED })).toBe('2026-09-24 10:00')
    // Empty and junk keep their existing renderings.
    expect(formatFieldDisplay({ field, value: null })).toBe('—')
    expect(formatFieldDisplay({ field, value: 'not a date' })).toBe('not a date')
  })

  it('a zone-less stored string is read as a business wall clock, not in the browser zone', () => {
    setBusinessTimezone('Asia/Kathmandu')
    expect(dateTimeInputValue('2026-09-24T06:45')).toBe('2026-09-24 06:45')
    expect(dateTimeInputValue('2026-09-24 06:45:00')).toBe('2026-09-24 06:45')
  })

  it('parses editor text as a business wall clock; round-trip is exact', () => {
    expect(dateTimeValueFromInput('2026-09-24 09:00')).toBe(STORED)
    expect(dateTimeInputValue(STORED)).toBe('2026-09-24 09:00')
    setBusinessTimezone('Asia/Kathmandu')
    expect(dateTimeValueFromInput('2026-09-24 06:45')).toBe(STORED)
    expect(dateTimeInputValue(dateTimeValueFromInput('2026-12-31 23:59'))).toBe('2026-12-31 23:59')
    // An explicit zone argument (the field's zone) is honoured.
    expect(dateTimeValueFromInput('2026-09-24 10:00', 'Asia/Tokyo')).toBe(STORED)
    expect(dateTimeInputValue(STORED, 'Asia/Tokyo')).toBe('2026-09-24 10:00')
  })

  it('accepts the spellings people type, rejects partial / impossible ones, and never turns a partial draft into a clear', () => {
    const tz = 'Asia/Shanghai'
    for (const text of ['2026-09-24 09:00', '2026-09-24T09:00', '2026/9/24 9:00', '2026.09.24 09:00', '  2026-09-24   09:00  ', '2026-09-24 09:00:00']) {
      expect(parseDateTimeInput(text, tz)).toEqual({ ok: true, value: STORED })
    }
    expect(parseDateTimeInput('2026-09-24 09:00:30', tz)).toEqual({ ok: true, value: '2026-09-24T01:00:30.000Z' })
    expect(parseDateTimeInput('', tz)).toEqual({ ok: true, value: null })
    expect(parseDateTimeInput('   ', tz)).toEqual({ ok: true, value: null })
    for (const text of ['2026-09-24', '2026-09-24 09', '2026-09-24 09:0', '2026-09-2', '2026-02-30 09:00', '2026-13-01 09:00', '2026-09-24 24:00', '2026-09-24 09:60', '09:00', 'tomorrow', '2026-09-24 9:00 PM']) {
      expect(parseDateTimeInput(text, tz)).toEqual({ ok: false })
    }
    expect(parseDateTimeInput('2028-02-29 12:00', tz).ok).toBe(true) // leap day
    expect(dateTimeValueFromInput('garbage')).toBeNull()
  })

  it('local → UTC is exact across a DST business zone (both sides of the transition)', () => {
    // America/New_York: EDT (UTC-4) in summer, EST (UTC-5) in winter.
    expect(new Date(wallClockToUtcMs({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York')).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(new Date(wallClockToUtcMs({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, 'America/New_York')).toISOString()).toBe('2026-12-01T14:00:00.000Z')
    expect(dateTimeInputValue('2026-11-01T14:00:00.000Z', 'America/New_York')).toBe('2026-11-01 09:00')
    expect(dateTimeValueFromInput('2026-11-01 09:00', 'America/New_York')).toBe('2026-11-01T14:00:00.000Z')
    expect(dateTimeValueFromInput('2026-03-08 09:00', 'America/New_York')).toBe('2026-03-08T13:00:00.000Z')
    // A wall clock just past the spring-forward (07:00Z): the first guess's offset is still EST, so only
    // the second correction lands it on 07:30Z (03:30 EDT) instead of 08:30Z (04:30 EDT).
    expect(dateTimeValueFromInput('2026-03-08 03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
    expect(dateTimeInputValue('2026-03-08T07:30:00.000Z', 'America/New_York')).toBe('2026-03-08 03:30')
  })

  it('zone hint: compares UTC offsets, labels Beijing time, and stays silent when the clocks agree', () => {
    const at = new Date(STORED)
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset')
    spy.mockReturnValue(240) // "browser" in New York (EDT)
    expect(browserTimezoneDiffers('Asia/Shanghai', at)).toBe(true)
    expect(dateTimeZoneHint('Asia/Shanghai', true, at)).toBe('北京时间')
    expect(dateTimeZoneHint('Asia/Shanghai', false, at)).toBe('Beijing time')
    expect(dateTimeZoneHint('Asia/Tokyo', false, at)).toBe('Asia/Tokyo (UTC+09:00)')
    spy.mockReturnValue(-480) // "browser" at UTC+8 (Shanghai, Singapore, …) — same wall clock
    expect(browserTimezoneDiffers('Asia/Shanghai', at)).toBe(false)
    expect(dateTimeZoneHint('Asia/Shanghai', true, at)).toBe('')
    expect(businessTimezoneLabel('Asia/Shanghai', true)).toBe('北京时间')
  })
})

describe('business timezone — editors and displays', () => {
  beforeEach(() => {
    resetBusinessTimezone()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    resetBusinessTimezone()
    vi.restoreAllMocks()
  })

  it('grid cell renderer shows YYYY-MM-DD HH:mm in the business zone (dateTime and createdTime)', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const dt = mount(() => h(MetaCellRenderer, {
      field: { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } },
      value: STORED,
    }))
    await flushUi()
    expect(dt.container.querySelector('.meta-cell-renderer__date-time')?.textContent).toBe('2026-09-24 06:45')
    dt.unmount()

    const ct = mount(() => h(MetaCellRenderer, {
      field: { id: 'fld_ct', name: 'Created', type: 'createdTime' },
      value: STORED,
    }))
    await flushUi()
    expect(ct.container.querySelector('.meta-cell-renderer__system')?.textContent).toBe('2026-09-24 06:45')
    ct.unmount()
  })

  it('grid cell editor: shows the business wall clock, emits the exact UTC instant, never clears on a partial draft', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const view = mount(() => h(MetaCellEditor, {
      field: { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } },
      modelValue: STORED,
      'onUpdate:modelValue': updateSpy,
      onConfirm: confirmSpy,
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()

    const input = view.container.querySelector('input[data-meta-datetime-input]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.type).toBe('text')
    expect(input.classList.contains('meta-cell-editor__input')).toBe(true)
    expect(input.value).toBe('2026-09-24 06:45')
    expect(input.placeholder).toBe('e.g. 2026-09-24 09:00') // the format by example (zh: 如 2026-09-24 09:00)

    typeInto(input, '2026-09-24 1') // partial
    typeInto(input, '2026-09-24 10:0') // still partial
    await flushUi()
    expect(updateSpy).not.toHaveBeenCalled()

    typeInto(input, '2026-09-24 10:30')
    await flushUi()
    expect(updateSpy).toHaveBeenLastCalledWith('2026-09-24T04:45:00.000Z')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    typeInto(input, '')
    await flushUi()
    expect(updateSpy).toHaveBeenLastCalledWith(null)
    view.unmount()
  })

  it('grid cell editor (B2): an unparseable draft is never dropped — Enter/Tab/blur keep it visible with an error, Escape discards', async () => {
    const confirmSpy = vi.fn()
    const blurCommitSpy = vi.fn()
    const tabCommitSpy = vi.fn()
    const cancelSpy = vi.fn()
    const updateSpy = vi.fn()
    const view = mount(() => h(MetaCellEditor, {
      field: { id: 'fld_dt', name: 'When', type: 'dateTime' },
      modelValue: STORED,
      hostCommitPolicy: 'grid',
      'onUpdate:modelValue': updateSpy,
      onConfirm: confirmSpy,
      onBlurCommit: blurCommitSpy,
      onTabCommit: tabCommitSpy,
      onCancel: cancelSpy,
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('input[data-meta-datetime-input]') as HTMLInputElement
    const errorEl = () => view.container.querySelector('[data-meta-datetime-error]')
    // Still typing: no error yet, nothing emitted.
    typeInto(input, '2026-09-24 25:00')
    await flushUi()
    expect(errorEl()).toBeNull()
    expect(updateSpy).not.toHaveBeenCalled()

    // Enter on garbage: blocked, error shown, draft kept — NOT reverted to the stored value.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(input.value).toBe('2026-09-24 25:00')
    expect(errorEl()?.textContent).toBe('Invalid date-time — use the form 2026-09-24 09:00')
    expect(errorEl()?.textContent).not.toContain('25:00') // values-free
    expect(input.getAttribute('aria-invalid')).toBe('true')

    // Tab and click-away (blur) do not commit the stale staged value over a visible error either.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(tabCommitSpy).not.toHaveBeenCalled()
    expect(blurCommitSpy).not.toHaveBeenCalled()
    expect(input.value).toBe('2026-09-24 25:00')

    // Fixing the text clears the error at once; Enter then confirms the corrected instant.
    typeInto(input, '2026-09-24 21:00')
    await flushUi()
    expect(errorEl()).toBeNull()
    expect(updateSpy).toHaveBeenLastCalledWith('2026-09-24T13:00:00.000Z')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    // Escape is the explicit discard path.
    typeInto(input, 'garbage')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('grid cell editor: a VALID draft still click-away-commits and Tab-commits as before', async () => {
    const blurCommitSpy = vi.fn()
    const tabCommitSpy = vi.fn()
    const view = mount(() => h(MetaCellEditor, {
      field: { id: 'fld_dt', name: 'When', type: 'dateTime' },
      modelValue: STORED,
      hostCommitPolicy: 'grid',
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onBlurCommit: blurCommitSpy,
      onTabCommit: tabCommitSpy,
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('input[data-meta-datetime-input]') as HTMLInputElement
    typeInto(input, '2026-09-24 10:30')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(blurCommitSpy).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('2026-09-24 10:30')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await flushUi()
    expect(tabCommitSpy).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('form view: typing 09:00 submits 01:00Z (Asia/Shanghai default) and shows 09:00 back', async () => {
    const submitSpy = vi.fn()
    const view = mount(() => h(MetaFormView, {
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime', property: { timezone: 'UTC' } }],
      record: { id: 'rec_1', version: 1, data: { fld_dt: '2026-09-23T02:30:00.000Z' } },
      loading: false,
      readOnly: false,
      onSubmit: submitSpy,
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('#field_fld_dt') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('2026-09-23 10:30')
    typeInto(input, '2026-09-24 09:00')
    await flushUi()
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).toHaveBeenCalledWith({ fld_dt: STORED })
    view.unmount()
  })

  it('form view: shows the 北京时间 hint only when the browser clock differs', async () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240)
    const props = {
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime' }],
      record: { id: 'rec_1', version: 1, data: { fld_dt: STORED } },
      loading: false,
      readOnly: false,
      onSubmit: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }
    const away = mount(() => h(MetaFormView, props))
    await flushUi()
    const hint = away.container.querySelector('[data-meta-datetime-zone-hint]')
    expect(hint?.textContent?.trim()).toMatch(/^(北京时间|Beijing time)$/)
    away.unmount()

    spy.mockReturnValue(-480)
    const home = mount(() => h(MetaFormView, props))
    await flushUi()
    expect(home.container.querySelector('[data-meta-datetime-zone-hint]')).toBeNull()
    home.unmount()
  })

  it('record drawer: change patches the exact UTC instant, and an unchanged instant does not patch', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const view = mount(() => h(MetaRecordDrawer, {
      visible: true,
      record: { id: 'rec_1', version: 1, data: { fld_dt: STORED } },
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime', property: { timezone: 'UTC' } }],
      canEdit: true,
      canComment: false,
      canDelete: false,
      onPatch: patchSpy,
    }))
    await flushUi()
    const input = view.container.querySelector('#drawer_field_fld_dt') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('2026-09-24 06:45')

    // Same instant, different spelling: no patch (no history noise).
    typeInto(input, '2026-9-24 6:45')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input.value).toBe('2026-09-24 06:45')

    typeInto(input, '2026-09-25 08:00')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('fld_dt', '2026-09-25T02:15:00.000Z')

    // Garbage never patches; the box reverts to the stored value.
    typeInto(input, 'next tuesday')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('2026-09-24 06:45')
    view.unmount()
  })

  it('the multitable client adopts businessTimezone from /context and /form-context', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const body = url.includes('/form-context')
        ? { ok: true, data: { mode: 'form', readOnly: false, submitPath: '/x', sheet: { id: 's' }, fields: [], capabilities: {}, businessTimezone: 'Asia/Kathmandu' } }
        : { ok: true, data: { sheets: [], views: [], capabilities: {}, businessTimezone: 'Asia/Tokyo' } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const client = new MultitableApiClient({ fetchFn: fetchFn as unknown as typeof fetch })
    const field = { id: 'f', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField

    expect(formatFieldDisplay({ field, value: STORED })).toBe('2026-09-24 09:00')
    await client.loadContext({ sheetId: 's' })
    expect(getBusinessTimezone()).toBe('Asia/Tokyo')
    expect(formatFieldDisplay({ field, value: STORED })).toBe('2026-09-24 10:00')
    await client.loadFormContext({ viewId: 'v' })
    expect(getBusinessTimezone()).toBe('Asia/Kathmandu')
    expect(formatFieldDisplay({ field, value: STORED })).toBe('2026-09-24 06:45')
  })

  it('date-only fields are untouched (floating calendar day, #3417)', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const view = mount(() => h(MetaCellEditor, {
      field: { id: 'fld_d', name: 'Day', type: 'date' },
      modelValue: '2026-09-24',
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('input') as HTMLInputElement
    expect(input.type).toBe('date')
    expect(input.value).toBe('2026-09-24')
    expect(view.container.querySelector('[data-meta-datetime-input]')).toBeNull()
    view.unmount()
  })
})

// ---------------------------------------------------------------------------------------------------------
// PR #6083 adversarial review follow-ups (B1 / B2 / S1 / S2 / S3 / S6 / N1 / N3 / N5 / N6 / N7).
// ---------------------------------------------------------------------------------------------------------

describe('parser normalisation (B2 / N7) — what people type is read, what cannot be read is refused', () => {
  const tz = 'Asia/Shanghai'
  afterEach(() => resetBusinessTimezone())

  it('accepts full-width digits / colon, 年月日 / 时分 words, `/` and `.`, `T`, seconds and millis', () => {
    for (const text of [
      '２０２６－０９－２４　０９：００',
      '２０２６-０９-２４ ０９：００',
      '2026年9月24日 9:00',
      '2026年09月24日09:00',
      '2026年9月24日9时0分',
      '2026年9月24日 9点00分',
      '2026/9/24 9:00',
      '2026.09.24 09:00',
      '2026-09-24T09:00:00',
      '2026-09-24T09:00:00.000',
    ]) {
      expect(parseDateTimeInput(text, tz), text).toEqual({ ok: true, value: STORED })
    }
    expect(normalizeDateTimeInput('2026年9月24日 9时5分7秒')).toBe('2026-9-24 9:05:07')
  })

  it('an ISO string with Z / ±hh:mm / millis is an ABSOLUTE instant — not re-read as a business wall clock', () => {
    setBusinessTimezone('Asia/Kathmandu')
    expect(parseDateTimeInput('2026-09-24T01:00:00.000Z', getBusinessTimezone())).toEqual({ ok: true, value: STORED })
    expect(parseDateTimeInput('2026-09-24T01:00:00Z', getBusinessTimezone())).toEqual({ ok: true, value: STORED })
    expect(parseDateTimeInput('2026-09-24T09:00:00+08:00', getBusinessTimezone())).toEqual({ ok: true, value: STORED })
    expect(parseDateTimeInput('2026-09-24 09:00+0800', getBusinessTimezone())).toEqual({ ok: true, value: STORED })
    expect(parseDateTimeInput('2026-09-23T21:00:00.250-04:00', getBusinessTimezone())).toEqual({ ok: true, value: '2026-09-24T01:00:00.250Z' })
    expect(parseDateTimeTextToUtcMs('Thu, 24 Sep 2026 01:00:00 GMT', getBusinessTimezone())).toBe(Date.parse(STORED))
  })

  it('rejects MIXED separators (N7), impossible dates, zone-less free text, a bare date, 12-hour suffixes', () => {
    for (const text of ['2026-09/24 09:00', '2026/09.24 09:00', '2026.09-24 09:00', '2026-02-30 09:00', '2026-09-24 24:00', 'Sep 24 2026 09:00', 'tomorrow 9am', '2026-09-24', '2026-09-24 9:00 PM', '20260924 0900']) {
      expect(parseDateTimeInput(text, tz), text).toEqual({ ok: false })
    }
    // A bare date IS accepted for a stored / prefilled value (midnight in the zone) — only the editor requires the time.
    expect(dateTimeInputValue('2026-09-24')).toBe('2026-09-24 00:00')
  })

  it('years 0000–0099 are not remapped to 19xx (N3)', () => {
    expect(new Date(utcMsFromWallClock({ year: 99, month: 1, day: 1, hour: 0, minute: 0 })).toISOString()).toBe('0099-01-01T00:00:00.000Z')
    expect(new Date(Date.UTC(99, 0, 1)).toISOString()).toBe('1999-01-01T00:00:00.000Z') // the trap
    expect(parseDateTimeInput('0099-01-01 08:00', 'Etc/GMT-8')).toEqual({ ok: true, value: '0099-01-01T00:00:00.000Z' })
    expect(dateTimeInputValue('0099-01-01T00:00:00.000Z', 'Etc/GMT-8')).toBe('0099-01-01 08:00')
    // Asia/Shanghai in year 99 is on LMT (+08:05:43) — the wall clock still round-trips, in year 0099.
    const ms = wallClockToUtcMs({ year: 99, month: 1, day: 1, hour: 8, minute: 0 }, tz)
    expect(new Date(ms).getUTCFullYear()).toBe(98)
    expect(dateTimeInputValue(new Date(ms).toISOString(), tz)).toBe('0099-01-01 08:00')
  })
})

describe('DST rule (N1 / S6): gap → post-transition instant, overlap → earlier instant — same rule as the server', () => {
  const NY = 'America/New_York'
  const ny = (text: string) => dateTimeValueFromInput(text, NY)

  it('spring-forward GAP: 02:30 (does not exist) → 07:30Z, shown as 03:30 EDT', () => {
    expect(ny('2026-03-08 02:30')).toBe('2026-03-08T07:30:00.000Z')
    expect(dateTimeInputValue('2026-03-08T07:30:00.000Z', NY)).toBe('2026-03-08 03:30')
    expect(dateTimeValueFromInput('2026-03-29 02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z')
  })

  it('fall-back OVERLAP: 01:30 (exists twice) → the earlier instant 05:30Z (EDT), never 06:30Z', () => {
    expect(ny('2026-11-01 01:30')).toBe('2026-11-01T05:30:00.000Z')
    expect(dateTimeValueFromInput('2026-10-25 02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z') // CEST, the earlier one
  })

  it('is exact for the hours after a transition and well away from it', () => {
    expect(ny('2026-03-08 03:30')).toBe('2026-03-08T07:30:00.000Z')
    expect(ny('2026-03-08 06:00')).toBe('2026-03-08T10:00:00.000Z')
    expect(ny('2026-11-01 02:00')).toBe('2026-11-01T07:00:00.000Z')
    expect(ny('2026-07-01 09:00')).toBe('2026-07-01T13:00:00.000Z')
    expect(ny('2026-12-01 09:00')).toBe('2026-12-01T14:00:00.000Z')
    for (const [day, month] of [[8, 3], [1, 11]]) {
      for (let hour = 0; hour < 24; hour += 1) {
        if (month === 3 && hour === 2) continue // the non-existent gap hour
        const text = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:30`
        expect(dateTimeInputValue(ny(text), NY), text).toBe(text)
      }
    }
  })
})

describe('picker bridge (S3): the Element Plus panel works in browser-local Dates, the value never does', () => {
  it('pickerDateForValue gives a Date whose LOCAL components are the business wall clock; valueForPickerDate reads them back', () => {
    const tz = 'Asia/Kathmandu'
    const picked = pickerDateForValue(STORED, tz)!
    expect([picked.getFullYear(), picked.getMonth() + 1, picked.getDate(), picked.getHours(), picked.getMinutes()]).toEqual([2026, 9, 24, 6, 45])
    expect(valueForPickerDate(picked, tz)).toBe(STORED)
    expect(valueForPickerDate(new Date(2026, 8, 25, 8, 0), tz)).toBe('2026-09-25T02:15:00.000Z')
    expect(valueForPickerDate(new Date(2026, 8, 24, 9, 0), 'Asia/Shanghai')).toBe(STORED)
    expect(pickerDateForValue(null, tz)).toBeNull()
    expect(pickerDateForValue('junk', tz)).toBeNull()
    expect(valueForPickerDate(null, tz)).toBeNull()
  })

  it('MetaDateTimePicker: the trigger opens the panel; confirming emits the business-zone instant, never a browser-local one', async () => {
    const updateSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(MetaDateTimePicker, { modelValue: STORED, timezone: 'Asia/Kathmandu', 'onUpdate:modelValue': updateSpy })
    const instance = app.mount(container) as unknown as { applyPickedDate: (d: Date | null) => string | null }
    await flushUi()
    const trigger = container.querySelector('[data-meta-datetime-picker-trigger]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(document.body.querySelector('[data-meta-datetime-picker-panel]')).toBeNull()
    trigger.click()
    await flushUi()
    const panel = document.body.querySelector('[data-meta-datetime-picker-panel]')
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('.el-picker-panel, .el-date-picker, [class*="el-"]')).not.toBeNull() // the Element Plus panel rendered
    // What the panel would hand back for the highlighted value: 06:45 local components → the SAME stored instant.
    expect(instance.applyPickedDate(new Date(2026, 8, 24, 6, 45))).toBe(STORED)
    expect(updateSpy).toHaveBeenLastCalledWith(STORED)
    expect(instance.applyPickedDate(new Date(2026, 8, 25, 8, 0))).toBe('2026-09-25T02:15:00.000Z')
    expect(instance.applyPickedDate(null)).toBeNull()
    expect(updateSpy).toHaveBeenCalledTimes(2)
    ;(document.body.querySelector('[data-meta-datetime-picker-cancel]') as HTMLButtonElement).click()
    await flushUi()
    expect(document.body.querySelector('[data-meta-datetime-picker-panel]')).toBeNull()
    app.unmount()
    container.remove()
  })
})

// The tests in THIS describe are the ones the S6 child runs re-execute under TZ=UTC and TZ=America/New_York
// (see "UI surfaces under a foreign process zone" below): keep them free of anything that depends on the host
// zone other than through the code under test. Kathmandu (UTC+05:45) is used as the business zone so a
// browser-local regression can never coincide with the expected values on ANY host.
describe('business timezone — UI surfaces (TZ-independent)', () => {
  beforeEach(() => resetBusinessTimezone())
  afterEach(() => {
    document.body.innerHTML = ''
    resetBusinessTimezone()
    vi.restoreAllMocks()
  })

  it('form view: typing 06:45 in a Kathmandu business zone submits 01:00Z and shows 06:45 back', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const submitSpy = vi.fn()
    const view = mount(() => h(MetaFormView, {
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime', property: { timezone: 'UTC' } }],
      record: { id: 'rec_1', version: 1, data: { fld_dt: '2026-09-23T02:30:00.000Z' } },
      loading: false,
      readOnly: false,
      onSubmit: submitSpy,
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('#field_fld_dt') as HTMLInputElement
    expect(input.value).toBe('2026-09-23 08:15')
    typeInto(input, '2026-09-24 06:45')
    await flushUi()
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).toHaveBeenCalledWith({ fld_dt: STORED })
    expect(view.container.querySelector('[data-meta-datetime-picker-trigger]')).not.toBeNull() // S3: picker beside the box
    view.unmount()
  })

  it('form view (B2): an unparseable draft shows an inline error, blocks submit, and never submits as empty or stale', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const submitSpy = vi.fn()
    const view = mount(() => h(MetaFormView, {
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime' }],
      record: { id: 'rec_1', version: 1, data: { fld_dt: STORED } },
      loading: false,
      readOnly: false,
      onSubmit: submitSpy,
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('#field_fld_dt') as HTMLInputElement
    typeInto(input, '2026-09-24 25:00')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    const error = () => view.container.querySelector('#error_fld_dt')
    expect(error()?.textContent).toBe('Invalid date-time — use the form 2026-09-24 09:00')
    expect(input.value).toBe('2026-09-24 25:00') // kept visible
    expect(input.getAttribute('aria-invalid')).toBe('true')
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).not.toHaveBeenCalled()
    expect(error()?.textContent).toBe('Invalid date-time — use the form 2026-09-24 09:00')
    // A garbage draft typed WITHOUT blurring first is caught by submit's own validate() too.
    typeInto(input, '2026-09-24 07:00')
    await flushUi()
    expect(error()).toBeNull()
    typeInto(input, 'next week')
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).not.toHaveBeenCalled()
    expect(error()).not.toBeNull()
    // Fix → error gone → submit carries the corrected instant.
    typeInto(input, '2026-09-24 07:00')
    await flushUi()
    expect(error()).toBeNull()
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).toHaveBeenCalledWith({ fld_dt: '2026-09-24T01:15:00.000Z' })
    view.unmount()
  })

  it('form view (S1): a wall-clock prefill is normalised to the business instant; an unreadable prefill is not seeded', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const submitSpy = vi.fn()
    const view = mount(() => h(MetaFormView, {
      fields: [
        { id: 'fld_dt', name: 'Visit time', type: 'dateTime' },
        { id: 'fld_bad', name: 'Other time', type: 'dateTime' },
        { id: 'fld_txt', name: 'Note', type: 'string' },
      ],
      record: null,
      initialValues: { fld_dt: '2026-09-24 06:45', fld_bad: 'whenever', fld_txt: 'hello' },
      loading: false,
      readOnly: false,
      onSubmit: submitSpy,
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    expect((view.container.querySelector('#field_fld_dt') as HTMLInputElement).value).toBe('2026-09-24 06:45')
    expect((view.container.querySelector('#field_fld_bad') as HTMLInputElement).value).toBe('')
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(submitSpy).toHaveBeenCalledWith({ fld_dt: STORED, fld_txt: 'hello' })
    view.unmount()
  })

  it('record drawer (B2): garbage on change shows the field error, keeps the draft, patches nothing; fixing clears it', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const view = mount(() => h(MetaRecordDrawer, {
      visible: true,
      record: { id: 'rec_1', version: 1, data: { fld_dt: STORED } },
      fields: [{ id: 'fld_dt', name: 'Visit time', type: 'dateTime', property: { timezone: 'UTC' } }],
      canEdit: true,
      canComment: false,
      canDelete: false,
      onPatch: patchSpy,
    }))
    await flushUi()
    const input = view.container.querySelector('#drawer_field_fld_dt') as HTMLInputElement
    const error = () => view.container.querySelector('[data-test="drawer-field-error"][data-field-id="fld_dt"]')
    expect(input.value).toBe('2026-09-24 06:45')
    expect(view.container.querySelector('[data-meta-datetime-picker-trigger]')).not.toBeNull() // S3

    typeInto(input, 'next tuesday')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input.value).toBe('next tuesday') // NOT reverted
    expect(error()?.textContent).toBe('Invalid date-time — use the form 2026-09-24 09:00')
    expect(error()?.textContent).not.toContain('tuesday')

    typeInto(input, '2026-09-25 08:00')
    await flushUi()
    expect(error()).toBeNull()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('fld_dt', '2026-09-25T02:15:00.000Z')
    view.unmount()
  })

  it('grid group header (N5) shows the business wall clock, not the raw ISO key', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const dtField = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
    const nameField = { id: 'fld_name', name: 'Name', type: 'string' } as MetaField
    const view = mount(() => h(MetaGridTable, {
      rows: [
        { id: 'r1', version: 1, data: { fld_name: 'a', fld_dt: STORED } },
        { id: 'r2', version: 1, data: { fld_name: 'b', fld_dt: STORED } },
        { id: 'r3', version: 1, data: { fld_name: 'c', fld_dt: 'not a date' } },
      ],
      visibleFields: [nameField, dtField],
      groupFields: [dtField],
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      selectedRecordId: null,
      canEdit: true,
      canDelete: true,
      onPatchCell: vi.fn(),
    }))
    await flushUi()
    const labels = Array.from(view.container.querySelectorAll('[data-test="group-header"] .meta-grid__group-label')).map((el) => el.textContent)
    expect(labels).toEqual(['2026-09-24 06:45', 'not a date'])
    expect(view.container.textContent).not.toContain('T01:00:00.000Z')
    view.unmount()
  })

  it('grid paste (S1): Ctrl+V of a wall clock patches the business-zone instant; unreadable text is passed through for the server to refuse', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const readText = vi.fn().mockResolvedValue('2026-09-24 06:45')
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
    const dtField = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
    const patchSpy = vi.fn()
    const view = mount(() => h(MetaGridTable, {
      rows: [{ id: 'r1', version: 3, data: { fld_dt: null } }],
      visibleFields: [dtField],
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      selectedRecordId: null,
      canEdit: true,
      canDelete: true,
      onPatchCell: patchSpy,
    }))
    await flushUi()
    const cell = view.container.querySelector('tbody tr.meta-grid__row .meta-grid__cell') as HTMLElement
    cell.click() // focus without opening the editor
    await flushUi()
    const paste = () => (view.container.querySelector('.meta-grid') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }))
    paste()
    await flushUi()
    expect(patchSpy).toHaveBeenCalledWith('r1', 'fld_dt', STORED, 3) // 06:45 Kathmandu = 01:00Z, never the browser's 06:45

    readText.mockResolvedValue('next tuesday')
    paste()
    await flushUi()
    expect(patchSpy).toHaveBeenLastCalledWith('r1', 'fld_dt', 'next tuesday', 3) // server grammar refuses → 400 → toast, not a silent drop
    view.unmount()
  })

  it('column header (N6): the zone hint appears once, in the dateTime header tooltip, only when the browser clock differs', async () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240) // browser in New York
    const field = { id: 'fld_dt', name: 'When', type: 'dateTime' } as MetaField
    const away = mount(() => h(MetaFieldHeader, { field }))
    await flushUi()
    const awayName = away.container.querySelector('.meta-field-header__name') as HTMLElement
    expect(awayName.getAttribute('title')).toMatch(/^When · (北京时间|Beijing time)$/)
    expect(awayName.getAttribute('data-meta-datetime-zone-hint')).toMatch(/^(北京时间|Beijing time)$/)
    away.unmount()
    const text = mount(() => h(MetaFieldHeader, { field: { id: 'fld_s', name: 'Note', type: 'string' } as MetaField }))
    await flushUi()
    expect((text.container.querySelector('.meta-field-header__name') as HTMLElement).getAttribute('title')).toBe('Note')
    text.unmount()

    spy.mockReturnValue(-480) // browser already at UTC+8
    const home = mount(() => h(MetaFieldHeader, { field }))
    await flushUi()
    const homeName = home.container.querySelector('.meta-field-header__name') as HTMLElement
    expect(homeName.getAttribute('title')).toBe('When')
    expect(homeName.hasAttribute('data-meta-datetime-zone-hint')).toBe(false)
    home.unmount()
  })

  it('filter row (S2): a dateTime value is shown and typed as the business wall clock and stored as the instant', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const fields = [{ id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } }] as MetaField[]
    const updates: Array<{ value?: unknown }> = []
    const view = mount(() => h(MetaFilterConditionRow, {
      rule: { fieldId: 'fld_dt', operator: 'is', value: STORED },
      fields,
      onUpdate: (rule: { value?: unknown }) => updates.push(rule),
    }))
    await flushUi()
    const input = view.container.querySelector('input[data-filter-datetime]') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toBe('2026-09-24 06:45')
    expect(input.placeholder).toBe('e.g. 2026-09-24 09:00')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    input.value = '2026-09-25 08:00'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(updates.at(-1)?.value).toBe('2026-09-25T02:15:00.000Z')
    input.value = 'whenever'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(updates.at(-1)?.value).toBe('whenever') // kept verbatim, never silently dropped
    input.value = ''
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(updates.at(-1)?.value).toBe('')
    view.unmount()

    const junk = mount(() => h(MetaFilterConditionRow, { rule: { fieldId: 'fld_dt', operator: 'is', value: 'whenever' }, fields, onUpdate: vi.fn() }))
    await flushUi()
    const junkInput = junk.container.querySelector('input[data-filter-datetime]') as HTMLInputElement
    expect(junkInput.value).toBe('whenever')
    expect(junkInput.getAttribute('aria-invalid')).toBe('true')
    junk.unmount()
  })

  it('export text (B1) and import parse (B1) agree: both use the business wall clock and round-trip', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const dt = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
    const tokyo = { id: 'fld_tk', name: 'Tokyo', type: 'dateTime', property: { timezone: 'Asia/Tokyo' } } as MetaField
    const created = { id: 'fld_ct', name: 'Created', type: 'createdTime' } as MetaField
    const text = { id: 'fld_s', name: 'Note', type: 'string' } as MetaField
    expect(dateTimeExportText(dt, STORED)).toBe('2026-09-24 06:45')
    expect(dateTimeExportText(tokyo, STORED)).toBe('2026-09-24 10:00')
    expect(dateTimeExportText(created, '2026-09-24T13:05:00.000Z')).toBe('2026-09-24 18:50')
    expect(dateTimeExportText(text, STORED)).toBeNull() // not a date-time field → caller keeps raw
    expect(dateTimeExportText(dt, 'not a date')).toBeNull()
    expect(dateTimeExportText(dt, null)).toBeNull()

    const built = await buildImportedRecords({
      parsedRows: [
        ['Alpha', dateTimeExportText(dt, STORED)!, dateTimeExportText(tokyo, STORED)!],
        ['Beta', '2026年9月25日 8:00', ''],
        ['Gamma', 'whenever', '2026-09-24 10:00'],
        ['Delta', STORED, '2026-09-24T01:00:00Z'],
      ],
      fieldMapping: { 0: 'fld_s', 1: 'fld_dt', 2: 'fld_tk' },
      fields: [text, dt, tokyo],
    })
    expect(built.records).toEqual([
      { fld_s: 'Alpha', fld_dt: STORED, fld_tk: STORED }, // export → import: identical instants
      { fld_s: 'Beta', fld_dt: '2026-09-25T02:15:00.000Z', fld_tk: null },
      { fld_s: 'Delta', fld_dt: STORED, fld_tk: STORED }, // absolute ISO kept
    ])
    expect(built.rowIndexes).toEqual([0, 1, 3])
    expect(built.failures).toEqual([
      { rowIndex: 2, message: 'Invalid date-time for When — use the form 2026-09-24 09:00', retryable: false, fieldId: 'fld_dt', fieldName: 'When' },
    ])
    expect(built.failures[0].message).not.toContain('whenever') // values-free
  })
})

describe('XLSX import — Excel native date cells (review must-fix 1) and date-only days as written (item 2)', () => {
  const xlsxModule = XLSX as unknown as Parameters<typeof parseXlsxBuffer>[0]
  const SERIAL_DAY = 46289 // 2026-09-24
  const SERIAL_0900 = 46289.375 // 2026-09-24 09:00
  afterEach(() => resetBusinessTimezone())

  function workbookWithDateCells(): Uint8Array {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'When', 'Day', 'Typed'],
      ['Alpha', SERIAL_0900, SERIAL_DAY, '2026-09-24 09:00'],
    ]) as Record<string, any>
    ws.B2.z = 'm/d/yy h:mm' // built-in numFmt 22
    ws.C2.z = 'm/d/yy' // built-in numFmt 14
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Rows')
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  }

  it('negative control: SheetJS renders those cells as "9/24/26 9:00" / "9/24/26" — text the importer grammar rejects', () => {
    const wb = XLSX.read(workbookWithDateCells(), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Rows, { header: 1, raw: false, defval: '' }) as string[][]
    expect(rows[1]).toEqual(['Alpha', '9/24/26 9:00', '9/24/26', '2026-09-24 09:00'])
    expect(parseDateTimeInput('9/24/26 9:00', 'Asia/Shanghai')).toEqual({ ok: false })
    expect(normalizeXlsxDateCells({ SSF: undefined }, wb.Sheets.Rows)).toBe(0) // no SSF → left alone
  })

  it('parseXlsxBuffer + buildImportedRecords: numFmt 22 → business-zone instant, numFmt 14 → the day as written', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const parsed = parseXlsxBuffer(xlsxModule, workbookWithDateCells())
    expect(parsed.rows).toEqual([['Alpha', '2026-09-24 09:00', '2026-09-24', '2026-09-24 09:00']])
    const built = await buildImportedRecords({
      parsedRows: parsed.rows,
      fieldMapping: { 0: 'fld_s', 1: 'fld_dt', 2: 'fld_d', 3: 'fld_dt2' },
      fields: [
        { id: 'fld_s', name: 'Name', type: 'string' },
        { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } },
        { id: 'fld_d', name: 'Day', type: 'date' },
        { id: 'fld_dt2', name: 'Typed', type: 'dateTime', property: { timezone: 'Asia/Tokyo' } },
      ] as MetaField[],
    })
    expect(built.failures).toEqual([])
    expect(built.records).toEqual([{
      fld_s: 'Alpha',
      fld_dt: '2026-09-24T03:15:00.000Z', // 09:00 in the Kathmandu business zone — the Excel wall clock
      fld_d: '2026-09-24', // the calendar day as written, no zone math
      fld_dt2: '2026-09-24T00:00:00.000Z', // the TEXT cell, untouched by the normaliser, read in the field's own zone (Tokyo)
    }])
  })

  it('honours a 1904-date-system workbook (re-judge item 2): the same serial is 2026-09-24, not 2022-09-23', () => {
    const ws = XLSX.utils.aoa_to_sheet([['When', 'Day'], [44827.375, 44827]]) as Record<string, any> // 1904-system serials
    ws.A2.z = 'm/d/yy h:mm'
    ws.B2.z = 'm/d/yy'
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Rows')
    wb.Workbook = { WBProps: { date1904: true } }
    const buffer = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    expect(XLSX.SSF.parse_date_code(44827.375)).toMatchObject({ y: 2022, m: 9, d: 23 }) // the trap, without the flag
    expect(parseXlsxBuffer(xlsxModule, buffer).rows).toEqual([['2026-09-24 09:00', '2026-09-24']])
  })

  it('date-only import (item 2): the calendar day as written, never shifted by the browser zone', async () => {
    expect(calendarDayFromText('2026-09-24')).toBe('2026-09-24')
    expect(calendarDayFromText('2026/9/24')).toBe('2026-09-24')
    expect(calendarDayFromText('2026年9月24日')).toBe('2026-09-24')
    expect(calendarDayFromText('２０２６－０９－２４')).toBe('2026-09-24')
    expect(calendarDayFromText('2026-09-24 23:30')).toBe('2026-09-24') // a time part never moves the day
    expect(calendarDayFromText('9/24/26')).toBe('2026-09-24') // an Excel-rendered US date: local components, not toISOString
    expect(calendarDayFromText('2026-09-24T00:00:00Z')).toBe('2026-09-24') // explicit zone → UTC day
    expect(calendarDayFromText('2026-02-30')).toBeNull()
    expect(calendarDayFromText('2026-09/24')).toBeNull() // mixed separators
    expect(calendarDayFromText('whenever')).toBeNull()
    expect(calendarDayFromText('')).toBeNull()
    // The old `new Date(val).toISOString().split('T')[0]` moved a locally-parsed day to the previous UTC day on
    // any UTC+ browser; the 年月日 spelling it could not read at all.
    const built = await buildImportedRecords({
      parsedRows: [['2026年9月24日', '9/24/26', '2026-09-24 23:30', 'whenever']],
      fieldMapping: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
      fields: [
        { id: 'a', name: 'A', type: 'date' }, { id: 'b', name: 'B', type: 'date' }, { id: 'c', name: 'C', type: 'date' }, { id: 'd', name: 'D', type: 'date' },
      ] as MetaField[],
    })
    expect(built.records).toEqual([{ a: '2026-09-24', b: '2026-09-24', c: '2026-09-24', d: 'whenever' }])
  })
})

describe('S4: the automation editor and the dateTime cells read ONE business zone; the two "UTC"s stay distinct', () => {
  afterEach(() => resetBusinessTimezone())

  it('automationBusinessTimezone() follows the server-provided zone, Asia/Shanghai until then', () => {
    expect(DEFAULT_AUTOMATION_BUSINESS_TIMEZONE).toBe(DEFAULT_BUSINESS_TIMEZONE)
    expect(automationBusinessTimezone()).toBe('Asia/Shanghai')
    expect(setBusinessTimezone('Asia/Tokyo')).toBe(true)
    expect(automationBusinessTimezone()).toBe('Asia/Tokyo')
    // A new schedule rule is saved with THAT zone; a legacy UTC rule is still never re-stamped.
    expect(triggerTimezoneForSave({ triggerType: 'schedule.cron', draftTimezone: undefined, storedRule: null })).toBe('Asia/Tokyo')
    expect(triggerTimezoneForSave({
      triggerType: 'schedule.date_field',
      draftTimezone: undefined,
      storedRule: { id: 'r1', triggerType: 'schedule.date_field', triggerConfig: {} },
    })).toBeUndefined()
    resetBusinessTimezone()
    expect(automationBusinessTimezone()).toBe('Asia/Shanghai')
  })

  it('field property "UTC" = unset (→ business zone) while triggerConfig "UTC" = real UTC', () => {
    setBusinessTimezone('Asia/Kathmandu')
    expect(resolveDateTimeTimezone({ timezone: 'UTC' })).toBe('Asia/Kathmandu') // unset marker
    expect(isUtcTriggerTimezone('UTC')).toBe(true) // real UTC for a legacy rule
    expect(isUtcTriggerTimezone(undefined)).toBe(true)
    expect(isUtcTriggerTimezone('Asia/Kathmandu')).toBe(false)
    expect(effectiveTriggerTimezone({ triggerType: 'schedule.cron', draftTimezone: 'UTC', storedRule: null })).toBe('UTC')
  })
})

describe('grid (review item 3): moving to another cell never drops an invalid dateTime draft', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    resetBusinessTimezone()
  })

  const dtField = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
  const nameField = { id: 'fld_name', name: 'Name', type: 'string' } as MetaField
  function mountGrid(patchSpy: ReturnType<typeof vi.fn>) {
    return mount(() => h(MetaGridTable, {
      rows: [
        { id: 'r1', version: 1, data: { fld_name: 'a', fld_dt: STORED } },
        { id: 'r2', version: 1, data: { fld_name: 'b', fld_dt: null } },
      ],
      visibleFields: [dtField, nameField],
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      selectedRecordId: null,
      canEdit: true,
      canDelete: true,
      onPatchCell: patchSpy,
    }))
  }
  const cellAt = (root: HTMLElement, r: number, c: number) =>
    root.querySelectorAll('tbody tr.meta-grid__row')[r]!.querySelectorAll('.meta-grid__cell')[c] as HTMLElement
  const editorInput = (root: HTMLElement) => root.querySelector('input[data-meta-datetime-input]') as HTMLInputElement | null
  const errorEl = (root: HTMLElement) => root.querySelector('[data-meta-datetime-error]')

  it('single-click and double-click on other cells are blocked while the draft is invalid; fixing it commits; Escape discards', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const view = mountGrid(patchSpy)
    await flushUi()
    const root = view.container
    const dtCell = cellAt(root, 0, 0)
    dtCell.click()
    dtCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    const input = editorInput(root)!
    expect(input).not.toBeNull()
    expect(input.value).toBe('2026-09-24 06:45')

    // Type garbage, then do what a browser does when the mouse goes to another cell: blur, then click.
    typeInto(input, '2026-09-24 25:00')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(errorEl(root)).not.toBeNull()
    cellAt(root, 0, 1).click()
    await flushUi()
    expect(editorInput(root)).toBe(input) // the SAME editor is still mounted
    expect(input.value).toBe('2026-09-24 25:00') // the draft is still there
    expect(errorEl(root)).not.toBeNull()
    expect(patchSpy).not.toHaveBeenCalled()

    // Double-click on a different cell (startEdit) is blocked the same way.
    const other = cellAt(root, 1, 0)
    other.click()
    other.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(editorInput(root)).toBe(input)
    expect(root.querySelectorAll('input[data-meta-datetime-input]').length).toBe(1) // never two drafts
    expect(patchSpy).not.toHaveBeenCalled()

    // Fix the text: the block lifts; Enter commits the corrected instant and closes the editor.
    typeInto(input, '2026-09-24 10:30')
    await flushUi()
    expect(errorEl(root)).toBeNull()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()
    expect(patchSpy).toHaveBeenCalledWith('r1', 'fld_dt', '2026-09-24T04:45:00.000Z', 1)
    expect(editorInput(root)).toBeNull()

    // Escape on an invalid draft is the explicit discard: the editor closes, nothing is patched, and the
    // next cell can be edited normally.
    const again = cellAt(root, 0, 0)
    again.click()
    again.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    const input2 = editorInput(root)!
    typeInto(input2, 'garbage')
    input2.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(errorEl(root)).not.toBeNull()
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi()
    expect(editorInput(root)).toBeNull()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    other.click()
    other.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(editorInput(root)).not.toBeNull()
    view.unmount()
  })

  // Re-judge of PR #6083 (must-fix): the flag must not outlive the editor. A toolbar action (page change,
  // filter/search, sort under virtualization, row delete, hide-field, view switch) can remove the editing
  // row or field from the rendered set while the draft is invalid; the grid must still enter edit mode
  // afterwards. Both defences are exercised end to end here; multitable-datetime-grid-lockout.spec.ts
  // isolates the grid-side one with an editor stub that never reports back.
  function mountReactiveGrid(patchSpy: ReturnType<typeof vi.fn>) {
    const state = reactive({
      rows: [
        { id: 'r1', version: 1, data: { fld_name: 'a', fld_dt: STORED } },
        { id: 'r2', version: 1, data: { fld_name: 'b', fld_dt: null } },
      ] as MetaRecord[],
      fields: [dtField, nameField] as MetaField[],
    })
    const view = mount(() => h(MetaGridTable, {
      rows: state.rows,
      visibleFields: state.fields,
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      selectedRecordId: null,
      canEdit: true,
      canDelete: true,
      onPatchCell: patchSpy,
    }))
    return { state, view }
  }
  async function openInvalidDraft(root: HTMLElement) {
    const dtCell = cellAt(root, 0, 0)
    dtCell.click()
    dtCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'garbage')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(errorEl(root)).not.toBeNull()
    // The block is armed: a click elsewhere keeps this editor.
    cellAt(root, 1, 1).click()
    await flushUi()
    expect(editorInput(root)).toBe(input)
  }

  it('editor torn down by a ROW change (page / filter / delete) while its draft is invalid: the next click and double-click open an editor again', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const { state, view } = mountReactiveGrid(patchSpy)
    await flushUi()
    const root = view.container
    await openInvalidDraft(root)

    state.rows = state.rows.filter((row) => row.id !== 'r2' ? false : true) // only r2 remains — r1 (the editing row) left the rendered set
    await flushUi()
    expect(editorInput(root)).toBeNull()

    const target = cellAt(root, 0, 1) // r2 / Name
    target.click()
    await flushUi()
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('.meta-cell-editor input')).not.toBeNull() // edit mode is available again
    expect(patchSpy).not.toHaveBeenCalled() // the garbage never became data; r1 was gone, so nothing stale was committed
    view.unmount()
  })

  it('editor torn down by HIDING the field while its draft is invalid: the next double-click opens an editor again', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const { state, view } = mountReactiveGrid(patchSpy)
    await flushUi()
    const root = view.container
    await openInvalidDraft(root)

    state.fields = [nameField] // the dateTime column is hidden
    await flushUi()
    expect(editorInput(root)).toBeNull()

    const target = cellAt(root, 0, 0) // r1 / Name (now column 0)
    target.click()
    await flushUi()
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('.meta-cell-editor input')).not.toBeNull()
    expect(patchSpy).not.toHaveBeenCalled() // the staged value was still the stored one — no patch
    view.unmount()
  })

  it('MetaCellEditor reports invalidDraft=false on unmount (the editor-side half of the defence)', async () => {
    const invalidSpy = vi.fn()
    const view = mount(() => h(MetaCellEditor, {
      field: dtField,
      modelValue: STORED,
      hostCommitPolicy: 'grid',
      'onUpdate:modelValue': vi.fn(),
      'onUpdate:invalidDraft': invalidSpy,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('input[data-meta-datetime-input]') as HTMLInputElement
    typeInto(input, 'garbage')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(invalidSpy).toHaveBeenLastCalledWith(true)
    view.unmount()
    expect(invalidSpy).toHaveBeenLastCalledWith(false)
  })

  it('a VALID draft still commits when another cell is clicked (the D2 click-away behaviour is unchanged)', async () => {
    setBusinessTimezone('Asia/Kathmandu')
    const patchSpy = vi.fn()
    const view = mountGrid(patchSpy)
    await flushUi()
    const root = view.container
    const dtCell = cellAt(root, 0, 0)
    dtCell.click()
    dtCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, '2026-09-25 08:00')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    cellAt(root, 0, 1).click()
    await flushUi()
    expect(editorInput(root)).toBeNull()
    expect(patchSpy).toHaveBeenCalledWith('r1', 'fld_dt', '2026-09-25T02:15:00.000Z', 1)
    view.unmount()
  })
})

describe('UI surfaces under a foreign process zone (S6 — child vitest runs)', { timeout: 240_000 }, () => {
  const VITEST_ENTRY = path.resolve(TESTS_DIR, '../node_modules/vitest/vitest.mjs')
  const SPEC = path.relative(path.resolve(TESTS_DIR, '..'), fileURLToPath(import.meta.url))
  interface ChildSummary { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number }

  function runChild(tz: string): ChildSummary {
    // `-t` selects ONLY the "UI surfaces (TZ-independent)" describe above; META_BUSINESS_TZ_CHILD stops the
    // child from spawning grandchildren. The JSON reporter is the machine-readable result; a failing child
    // exits non-zero, so its stdout is read off the error to keep the failure legible (counts, not "Command
    // failed").
    let stdout: string
    try {
      stdout = execFileSync(process.execPath, [VITEST_ENTRY, 'run', SPEC, '-t', 'UI surfaces \\(TZ-independent\\)', '--reporter=json'], {
        cwd: path.resolve(TESTS_DIR, '..'),
        env: { ...process.env, TZ: tz, META_BUSINESS_TZ_CHILD: '1', CI: process.env.CI ?? '1' },
        encoding: 'utf8',
        timeout: 220_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
      stdout = String(failed.stdout ?? '')
      if (!stdout.includes('"numTotalTests"')) {
        throw new Error(`child vitest (TZ=${tz}) produced no JSON summary: ${failed.message ?? ''}\n${String(failed.stderr ?? '').slice(-2000)}`)
      }
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
    'the form view / drawer / grid / filter / export surfaces pass with the process (browser) zone forced to %s',
    (tz) => {
      const summary = runChild(tz)
      expect(summary.numFailedTests).toBe(0)
      // The UI-surfaces describe holds 9 tests; `-t` leaves the rest "skipped" (the JSON reporter's own
      // bookkeeping of filtered tests varies by version, so only the floor is asserted).
      expect(summary.numPassedTests).toBeGreaterThanOrEqual(9)
    },
  )
})
