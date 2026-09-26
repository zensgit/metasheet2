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
import { createApp, h, nextTick } from 'vue'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import {
  DEFAULT_BUSINESS_TIMEZONE,
  browserTimezoneDiffers,
  businessTimezoneLabel,
  dateTimeZoneHint,
  getBusinessTimezone,
  parseDateTimeInput,
  resetBusinessTimezone,
  resolveDateTimeTimezone,
  setBusinessTimezone,
  wallClockToUtcMs,
} from '../src/multitable/utils/business-timezone'
import {
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
    expect(input.placeholder).toBe('YYYY-MM-DD HH:mm')

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

  it('grid cell editor: an unparseable leftover reverts on blur to the stored value', async () => {
    const view = mount(() => h(MetaCellEditor, {
      field: { id: 'fld_dt', name: 'When', type: 'dateTime' },
      modelValue: STORED,
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    }))
    await flushUi()
    const input = view.container.querySelector('input[data-meta-datetime-input]') as HTMLInputElement
    typeInto(input, '2026-09-24 25:00')
    input.dispatchEvent(new FocusEvent('blur'))
    await flushUi()
    expect(input.value).toBe('2026-09-24 09:00')
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
