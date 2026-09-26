/**
 * A7a (客户反馈 2026-09-24 #4c, 裁定见 PR #6074): schedule-trigger time in the automation rule editor.
 *
 *   - 24-hour picker that does not follow the browser locale (the old native type="time" rendered am/pm);
 *     `data-field="timeOfDay"` and the stored 'HH:mm' shape are unchanged.
 *   - NEW schedule config (date reminder + cron) is saved with triggerConfig.timezone = the business
 *     timezone (Asia/Shanghai).
 *   - LEGACY-PRESERVE: a saved rule of the same schedule type with no stored timezone has been firing on
 *     UTC; any edit keeps the key absent (never silently re-stamped, which would move it by 8h). It is shown
 *     as UTC with an explicit, confirmed 改为北京时间 switch: 01:00 UTC → 09:00, '' (09:00 UTC default) → 17:00.
 *   - Asia/Shanghai rules never mention UTC.
 *   - Opening a saved cron rule selects its own preset (it used to keep the stale default and a rename
 *     rewrote the cron).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { ElMessageBox } from 'element-plus'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import {
  analyzeCronForBusinessSwitch,
  automationBusinessTimezone,
  convertLegacyUtcTimeOfDay,
  dateReminderExample,
  effectiveTriggerTimezone,
  isLegacyUtcScheduleRule,
  legacyUtcSwitchImpact,
  timezoneOffsetMinutes,
  triggerTimeOfDayOptions,
  triggerTimezoneForSave,
  utcTimeOfDayInZone,
} from '../src/multitable/utils/automation-trigger-timezone'
import {
  automationCronPresetLabel,
  automationCronTimezoneHint,
  automationDateReminderExampleText,
  automationLegacyUtcScheduleNotice,
  automationReminderTimeHint,
  automationReminderTimeLabel,
  automationSwitchToBusinessTimezoneConfirm,
} from '../src/multitable/utils/meta-automation-labels'
// Review S1: the confirm text must match what the BACKEND actually does, so the parity block below runs the
// backend's own pure occurrence function (no DB, no imports beyond its sibling automation-timezone.ts).
import { computeDateReminderOccurrence } from '../../../packages/core-backend/src/multitable/automation-date-reminder'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'
import { epOptions, epSelectValue, epSetSelect } from './helpers/epControls'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_name', name: 'Name', type: 'string' },
  { id: 'fld_due', name: 'Due date', type: 'date' },
  { id: 'fld_due_at', name: 'Due at', type: 'dateTime' },
]

const REF_MS = Date.UTC(2026, 8, 25, 12, 0)

function savedRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_legacy',
    sheetId: 'sheet_1',
    name: 'Legacy reminder',
    triggerType: 'schedule.date_field',
    triggerConfig: { dateFieldId: 'fld_due', offsetDays: 3, direction: 'before', timeOfDay: '01:00' },
    actionType: 'update_record',
    actionConfig: {},
    enabled: true,
    actions: [{ type: 'update_record', config: { fieldUpdates: [] } }],
    ...overrides,
  } as AutomationRule
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, props) })
  app.mount(container)
  return { container, app }
}

function setName(container: HTMLElement, value: string) {
  const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
  nameInput.value = value
  nameInput.dispatchEvent(new Event('input'))
}

async function save(container: HTMLElement) {
  ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
  await flushPromises()
}

function triggerSection(container: HTMLElement): HTMLElement {
  const anchor = container.querySelector('[data-field="triggerType"]') as HTMLElement
  return anchor.closest('section') as HTMLElement
}

/** Everything a user can read in the trigger section, including the time picker's option labels. */
function triggerSectionReadableText(container: HTMLElement): string {
  const section = triggerSection(container)
  const placeholders = Array.from(section.querySelectorAll('[placeholder]')).map((el) => el.getAttribute('placeholder'))
  const timeSelect = section.querySelector('[data-field="timeOfDay"]')
  const timeOptions = timeSelect ? epOptions(timeSelect).map((option) => option.textContent ?? '') : []
  const cronSelect = section.querySelector('[data-field="cronPreset"]')
  const cronOptions = cronSelect ? epOptions(cronSelect).map((option) => option.textContent ?? '') : []
  return [section.textContent ?? '', ...placeholders, ...timeOptions, ...cronOptions].join('\n')
}

describe('A7a schedule timezone helpers', () => {
  it('business timezone is Asia/Shanghai via the single exported helper', () => {
    expect(automationBusinessTimezone()).toBe('Asia/Shanghai')
  })

  it('new schedule config saves the business timezone; a legacy UTC rule of the same type saves none', () => {
    // brand-new rule
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: undefined, storedRule: null })).toBe('Asia/Shanghai')
    expect(triggerTimezoneForSave({ triggerType: 'schedule.cron', draftTimezone: undefined, storedRule: null })).toBe('Asia/Shanghai')
    // legacy: saved with this schedule type, no stored timezone → keep absent (UTC)
    const legacy = savedRule()
    expect(isLegacyUtcScheduleRule(legacy, 'schedule.date_field')).toBe(true)
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: undefined, storedRule: legacy })).toBeUndefined()
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: '', storedRule: legacy })).toBeUndefined()
    expect(effectiveTriggerTimezone({ triggerType: 'schedule.date_field', draftTimezone: undefined, storedRule: legacy })).toBe('UTC')
    const legacyCron = savedRule({ triggerType: 'schedule.cron', triggerConfig: { cron: '0 0 * * *' } })
    expect(triggerTimezoneForSave({ triggerType: 'schedule.cron', draftTimezone: undefined, storedRule: legacyCron })).toBeUndefined()
    // legacy timezone lives in trigger.config only → still read (draftFromRule merges both)
    const viaTrigger = savedRule({ triggerConfig: {}, trigger: { type: 'schedule.date_field', config: { timezone: 'Asia/Shanghai' } } } as Partial<AutomationRule>)
    expect(isLegacyUtcScheduleRule(viaTrigger, 'schedule.date_field')).toBe(false)
    // an explicit draft timezone (incl. an explicit stored 'UTC') always wins
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: 'UTC', storedRule: legacy })).toBe('UTC')
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: 'Asia/Shanghai', storedRule: legacy })).toBe('Asia/Shanghai')
    // a saved rule switched INTO a schedule type from another type is new schedule config
    const recordRule = savedRule({ triggerType: 'record.created', triggerConfig: {} })
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: undefined, storedRule: recordRule })).toBe('Asia/Shanghai')
    // a prefilled rule object without an id is not a saved rule
    expect(triggerTimezoneForSave({ triggerType: 'schedule.date_field', draftTimezone: undefined, storedRule: savedRule({ id: '' }) })).toBe('Asia/Shanghai')
    // non-schedule triggers never get a timezone
    expect(triggerTimezoneForSave({ triggerType: 'record.created', draftTimezone: undefined, storedRule: null })).toBeUndefined()
    expect(triggerTimezoneForSave({ triggerType: 'schedule.interval', draftTimezone: undefined, storedRule: null })).toBeUndefined()
  })

  it('converts a legacy UTC time to the same instant in Asia/Shanghai: 01:00 → 09:00, empty → 17:00', () => {
    expect(convertLegacyUtcTimeOfDay('01:00', 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '09:00', dayShift: 0 })
    expect(convertLegacyUtcTimeOfDay('', 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '17:00', dayShift: 0 })
    expect(convertLegacyUtcTimeOfDay(undefined, 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '17:00', dayShift: 0 })
    expect(convertLegacyUtcTimeOfDay('15:59', 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '23:59', dayShift: 0 })
    // crosses midnight: (hh + 8) mod 24 and the day moved
    expect(convertLegacyUtcTimeOfDay('16:00', 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '00:00', dayShift: 1 })
    expect(convertLegacyUtcTimeOfDay('18:30', 'Asia/Shanghai', REF_MS)).toEqual({ timeOfDay: '02:30', dayShift: 1 })
    expect(utcTimeOfDayInZone('00:00', 'Asia/Shanghai', REF_MS)).toEqual({ time: '08:00', dayShift: 0 })
  })

  it('offers a locale-independent 24-hour list (00:00…23:45, 15-minute steps) and keeps an off-grid stored value', () => {
    const options = triggerTimeOfDayOptions('')
    expect(options).toHaveLength(96)
    expect(options[0]).toBe('00:00')
    expect(options[options.length - 1]).toBe('23:45')
    expect(options).toContain('13:00')
    for (const option of options) expect(option).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
    const withStored = triggerTimeOfDayOptions('09:07')
    expect(withStored).toHaveLength(97)
    expect(withStored).toContain('09:07')
  })

  it('builds the live example line on the business clock and names UTC only for a UTC rule', () => {
    const business = 'Asia/Shanghai'
    const zhBusiness = automationDateReminderExampleText(
      dateReminderExample({ offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: business, businessTimezone: business }),
      business,
      true,
    )
    expect(zhBusiness).toBe('例：日期为 9月30日、提前 3 天 → 9月27日 09:00 提醒')
    expect(automationDateReminderExampleText(
      dateReminderExample({ offsetDays: 3, direction: 'after', timeOfDay: '', timezone: business, businessTimezone: business }),
      business,
      true,
    )).toBe('例：日期为 9月30日、延后 3 天 → 10月3日 09:00 提醒')
    expect(automationDateReminderExampleText(
      dateReminderExample({ offsetDays: 0, direction: 'before', timeOfDay: '18:15', timezone: business, businessTimezone: business }),
      business,
      false,
    )).toBe('e.g. date Sep 30, same day → reminder on Sep 30 at 18:15')
    expect(automationDateReminderExampleText(
      dateReminderExample({ offsetDays: 3, direction: 'before', timeOfDay: '01:00', timezone: 'UTC', businessTimezone: business }),
      'UTC',
      true,
    )).toBe('例：日期为 9月30日、提前 3 天 → 9月27日 01:00 UTC 提醒（即北京时间 9月27日 09:00）')
    expect(automationDateReminderExampleText(
      dateReminderExample({ offsetDays: 3, direction: 'before', timeOfDay: '18:00', timezone: 'UTC', businessTimezone: business }),
      'UTC',
      false,
    )).toBe('e.g. date Sep 30, 3 days before → reminder on Sep 27 at 18:00 UTC (Sep 28 02:00 Beijing time)')
  })

  it('business-timezone copy never mentions UTC; the legacy copy does', () => {
    const business = 'Asia/Shanghai'
    expect(automationReminderTimeLabel(business, true)).toBe('提醒时间')
    expect(automationReminderTimeLabel(business, false)).toBe('Reminder time')
    expect(automationReminderTimeHint(business, true)).toBe('每天到这个时间（北京时间）检查一次，到期的记录会收到提醒；系统重启错过了，当天会补发。')
    expect(automationCronPresetLabel('0 0 * * *', true)).toBe('每天 00:00（北京时间）')
    expect(automationCronPresetLabel('0 0 * * *', false)).toBe('Daily at 00:00 (Beijing time)')
    expect(automationCronPresetLabel('0 0 * * 1', true, business)).toBe('每周一 00:00（北京时间）')
    for (const text of [
      automationReminderTimeLabel(business, true),
      automationReminderTimeLabel(business, false),
      automationReminderTimeHint(business, true),
      automationReminderTimeHint(business, false),
      automationCronTimezoneHint(business, true),
      automationCronTimezoneHint(business, false),
      automationCronPresetLabel('0 0 * * *', true, business),
      automationCronPresetLabel('0 0 * * 1', false, business),
    ]) {
      expect(text).not.toMatch(/UTC/)
    }
    // legacy UTC: truthful about both clocks (the old "每天午夜" fired at 08:00 Beijing)
    expect(automationReminderTimeLabel('UTC', true)).toBe('提醒时间（UTC）')
    expect(automationCronPresetLabel('0 0 * * *', true, 'UTC')).toBe('每天 00:00 UTC（北京时间 08:00）')
    expect(automationCronPresetLabel('0 0 * * *', false, 'UTC')).toBe('Daily at 00:00 UTC (08:00 Beijing time)')
    expect(automationCronPresetLabel('0 0 * * 1', true, 'UTC')).toBe('每周一 00:00 UTC（北京时间 08:00）')
  })

  it('switch impact: Asia/Shanghai is +480 min; dayShift 0 vs 1 move the two dateTime groups oppositely', () => {
    expect(timezoneOffsetMinutes('Asia/Shanghai', REF_MS)).toBe(480)
    expect(legacyUtcSwitchImpact('01:00', 'Asia/Shanghai', REF_MS)).toEqual({
      fromTimeOfDay: '01:00',
      toTimeOfDay: '09:00',
      dayShift: 0,
      dateFieldShiftDays: 0,
      dateTimeWindow: { start: '00:00', end: '08:00' },
      dateTimeInsideShiftDays: 1,
      dateTimeOutsideShiftDays: 0,
    })
    expect(legacyUtcSwitchImpact('18:00', 'Asia/Shanghai', REF_MS)).toEqual({
      fromTimeOfDay: '18:00',
      toTimeOfDay: '02:00',
      dayShift: 1,
      dateFieldShiftDays: -1,
      dateTimeWindow: { start: '00:00', end: '08:00' },
      dateTimeInsideShiftDays: 0,
      dateTimeOutsideShiftDays: -1,
    })
    expect(legacyUtcSwitchImpact('', 'Asia/Shanghai', REF_MS)).toMatchObject({ fromTimeOfDay: '09:00', toTimeOfDay: '17:00', dayShift: 0 })
  })

  it('S1/S2: full confirm text, dayShift=0 (01:00 UTC → 09:00), zh + en, field type unknown/date/dateTime', () => {
    const impact = legacyUtcSwitchImpact('01:00', 'Asia/Shanghai', REF_MS)
    const confirm = (fieldType: string | null, isZh: boolean) =>
      automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.date_field', impact, fieldType }, isZh)
    expect(confirm(null, true)).toBe(
      '提醒时间将由 01:00 UTC 换算为北京时间 09:00。'
      + '“日期”字段：每条提醒的时刻不变。'
      + '“日期时间”字段：北京时间 00:00 至 08:00 之前的记录会比原来晚一天提醒，其余记录提醒时刻不变。'
      + '提醒日变了的记录，保存后可能会多提醒一次。',
    )
    expect(confirm(null, false)).toBe(
      'The reminder time will be converted from 01:00 UTC to 09:00 Beijing time. '
      + 'On a "date" field, every reminder fires at the same moment as before. '
      + 'On a "date & time" field, records whose Beijing time is before 08:00 fire one day later than before; '
      + 'all other records fire at the same moment as before. '
      + 'Records whose reminder day changes may get one extra reminder after you save.',
    )
    // a date field alone: nothing moves → no extra-reminder sentence
    expect(confirm('date', true)).toBe('提醒时间将由 01:00 UTC 换算为北京时间 09:00。“日期”字段：每条提醒的时刻不变。')
    expect(confirm('date', false)).toBe(
      'The reminder time will be converted from 01:00 UTC to 09:00 Beijing time. On a "date" field, every reminder fires at the same moment as before.',
    )
    expect(confirm('dateTime', true)).toBe(
      '提醒时间将由 01:00 UTC 换算为北京时间 09:00。'
      + '“日期时间”字段：北京时间 00:00 至 08:00 之前的记录会比原来晚一天提醒，其余记录提醒时刻不变。'
      + '提醒日变了的记录，保存后可能会多提醒一次。',
    )
  })

  it('S1/S2: full confirm text, dayShift=1 (18:00 UTC → 02:00 next day), zh + en, field type unknown/date/dateTime', () => {
    const impact = legacyUtcSwitchImpact('18:00', 'Asia/Shanghai', REF_MS)
    const confirm = (fieldType: string | null, isZh: boolean) =>
      automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.date_field', impact, fieldType }, isZh)
    expect(confirm(null, true)).toBe(
      '提醒时间将由 18:00 UTC 换算为北京时间 02:00（跨到次日）。'
      + '“日期”字段：每条提醒都会比原来早一天。'
      + '“日期时间”字段：北京时间 00:00 至 08:00 之前的记录提醒时刻不变，其余记录会比原来早一天提醒。'
      + '提醒日变了的记录，保存后可能会多提醒一次。',
    )
    expect(confirm(null, false)).toBe(
      'The reminder time will be converted from 18:00 UTC to 02:00 Beijing time (the next day). '
      + 'On a "date" field, every reminder fires one day earlier than before. '
      + 'On a "date & time" field, records whose Beijing time is before 08:00 fire at the same moment as before; '
      + 'all other records fire one day earlier than before. '
      + 'Records whose reminder day changes may get one extra reminder after you save.',
    )
    expect(confirm('date', true)).toBe(
      '提醒时间将由 18:00 UTC 换算为北京时间 02:00（跨到次日）。“日期”字段：每条提醒都会比原来早一天。提醒日变了的记录，保存后可能会多提醒一次。',
    )
    expect(confirm('dateTime', false)).toBe(
      'The reminder time will be converted from 18:00 UTC to 02:00 Beijing time (the next day). '
      + 'On a "date & time" field, records whose Beijing time is before 08:00 fire at the same moment as before; '
      + 'all other records fire one day earlier than before. '
      + 'Records whose reminder day changes may get one extra reminder after you save.',
    )
    // S2: never both "unchanged" and "one day earlier" for the date field in the same dialog
    expect(confirm(null, true)).not.toContain('每条提醒的时刻不变')
    expect(confirm(null, false)).not.toContain('every reminder fires at the same moment')
  })

  it('S4: cron confirm names the rule’s own expression and its concrete before/after times', () => {
    const daily1 = analyzeCronForBusinessSwitch('0 1 * * *', 'Asia/Shanghai', REF_MS)
    expect(daily1).toMatchObject({ timezoneIndependent: false, restrictsDays: false, offsetMinutes: 480 })
    expect(automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron', cron: daily1 }, true)).toBe(
      'cron 表达式“0 1 * * *”不变，改按北京时间计时：原来在北京时间 09:00 执行，改后在北京时间 01:00 执行，每次都比原来早 8 小时。保存后生效。',
    )
    expect(automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron', cron: daily1 }, false)).toBe(
      'The cron expression "0 1 * * *" stays the same but runs on Beijing time: it used to run at 09:00 Beijing time and will run at 01:00 Beijing time, 8 hours earlier each time. Takes effect after saving.',
    )
    const twice = analyzeCronForBusinessSwitch('30 9,18 * * *', 'Asia/Shanghai', REF_MS)
    expect(automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron', cron: twice }, true)).toBe(
      'cron 表达式“30 9,18 * * *”不变，改按北京时间计时：原来在北京时间 02:30、17:30 执行，改后在北京时间 09:30、18:30 执行，每次都比原来早 8 小时。保存后生效。',
    )
    // day-restricted + crossing midnight: the old Beijing run is on the day AFTER the one the expression names
    const monday20 = analyzeCronForBusinessSwitch('0 20 * * 1', 'Asia/Shanghai', REF_MS)
    expect(automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron', cron: monday20 }, true)).toBe(
      'cron 表达式“0 20 * * 1”不变，改按北京时间计时：原来在北京时间 次日 04:00 执行（“次日”指表达式所写日期的第二天），改后在北京时间 20:00 执行，每次都比原来早 8 小时。保存后生效。',
    )
    // too many runs to list → generic, still names the expression and the 8 hours
    const every15 = analyzeCronForBusinessSwitch('*/15 9-17 * * 1-5', 'Asia/Shanghai', REF_MS)
    expect(every15.runs).toBeNull()
    expect(automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron', cron: every15 }, true)).toBe(
      'cron 表达式“*/15 9-17 * * 1-5”不变，改按北京时间计时，每次执行都会比原来早 8 小时。保存后生效。',
    )
  })

  it('N1: timezone-independent cron expressions are detected; anything else keeps the warning', () => {
    const independent = (expr: string) => analyzeCronForBusinessSwitch(expr, 'Asia/Shanghai', REF_MS).timezoneIndependent
    // same instants on UTC and Beijing: no fixed hour and no day restriction (or an hour set +8h maps onto itself)
    expect(independent('*/5 * * * *')).toBe(true)
    expect(independent('0 * * * *')).toBe(true)
    expect(independent('15,45 * * * *')).toBe(true)
    expect(independent('0 */2 * * *')).toBe(true)
    expect(independent('0 */4 * * *')).toBe(true)
    expect(independent('0 */8 * * *')).toBe(true)
    // depends on the clock
    expect(independent('0 0 * * *')).toBe(false)
    expect(independent('0 1 * * *')).toBe(false)
    expect(independent('0 */3 * * *')).toBe(false)
    expect(independent('0 */6 * * *')).toBe(false)
    expect(independent('0 * * * 1')).toBe(false) // hourly, but only on Mondays — the day is read on the clock
    expect(independent('*/5 * 1 * *')).toBe(false)
    expect(independent('0 0 * * 1')).toBe(false)
    // backend semantics: 'n/step' without a range is the single value n (NOT vixie's n..max)
    expect(independent('0 0/2 * * *')).toBe(false)
    // junk / unparseable → treated as dependent (the warning stays)
    expect(independent('')).toBe(false)
    expect(independent('0 0 * *')).toBe(false)
    expect(independent('0 25 * * *')).toBe(false)
    expect(independent('@daily')).toBe(false)
  })

  it('N3: legacy notices have no nested brackets and name the concrete run time', () => {
    const cronNotice = automationLegacyUtcScheduleNotice(
      { triggerType: 'schedule.cron', cron: analyzeCronForBusinessSwitch('0 1 * * *', 'Asia/Shanghai', REF_MS) },
      true,
    )
    expect(cronNotice).toBe('这条规则创建较早，cron 表达式“0 1 * * *”按 UTC 计时，实际在北京时间 09:00 执行。可一键改为北京时间。')
    expect(automationLegacyUtcScheduleNotice(
      { triggerType: 'schedule.cron', cron: analyzeCronForBusinessSwitch('0 1 * * *', 'Asia/Shanghai', REF_MS) },
      false,
    )).toBe('This rule was created earlier and its cron expression "0 1 * * *" runs on UTC, i.e. at 09:00 Beijing time. You can switch it to Beijing time.')
    expect(automationLegacyUtcScheduleNotice(
      { triggerType: 'schedule.cron', cron: analyzeCronForBusinessSwitch('*/15 9-17 * * 1-5', 'Asia/Shanghai', REF_MS) },
      true,
    )).toBe('这条规则创建较早，cron 表达式“*/15 9-17 * * 1-5”按 UTC 计时，表达式里的时间加 8 小时才是北京时间。可一键改为北京时间。')
    const dateNotice = automationLegacyUtcScheduleNotice({ triggerType: 'schedule.date_field', timeOfDay: '04:33' }, true)
    expect(dateNotice).toBe('这条规则创建较早，按 UTC 计时：当前提醒时间 04:33 UTC（北京时间 12:33）。可一键改为北京时间。')
    for (const text of [cronNotice, dateNotice]) {
      // no bracket opened inside another bracket
      let depth = 0
      for (const ch of text) {
        if (ch === '（' || ch === '(') { depth += 1; expect(depth).toBe(1) }
        if (ch === '）' || ch === ')') depth -= 1
      }
    }
    // N3 en grammar: no "between 00:00–08:00"
    const en = automationSwitchToBusinessTimezoneConfirm(
      { triggerType: 'schedule.date_field', impact: legacyUtcSwitchImpact('01:00', 'Asia/Shanghai', REF_MS), fieldType: null },
      false,
    )
    expect(en).not.toMatch(/between \d/)
  })
})

/**
 * Review S1 parity: the confirm text is generated from `legacyUtcSwitchImpact`; this proves those numbers
 * against the BACKEND's own occurrence function over a matrix of legacy times × values across a whole day ×
 * offsets, for both field types — and that the generated zh sentence names exactly the observed shift.
 */
describe('A7a switch impact ≡ backend computeDateReminderOccurrence', () => {
  const SH = 'Asia/Shanghai'
  const DAY = 86_400_000
  const TIMES = ['00:00', '01:00', '04:33', '07:59', '08:00', '12:00', '15:59', '16:00', '18:00', '23:45', '']
  const CONFIGS = [
    { offsetDays: 0, direction: 'before' as const },
    { offsetDays: 3, direction: 'before' as const },
    { offsetDays: 2, direction: 'after' as const },
  ]
  const zhShift = (days: number) => (days === 0 ? '提醒时刻不变' : `会比原来${days < 0 ? '早' : '晚'}一天提醒`)
  const shiftDays = (legacy: string | null, switched: string | null) => {
    expect(legacy).not.toBeNull()
    expect(switched).not.toBeNull()
    const diff = Date.parse(switched as string) - Date.parse(legacy as string)
    // always whole days: the instant of day is preserved by the conversion (`=== 0` also accepts -0)
    expect(diff % DAY === 0).toBe(true)
    return diff / DAY + 0
  }

  for (const legacyTime of TIMES) {
    it(`legacy ${legacyTime || "'' (09:00 default)"} UTC`, () => {
      const impact = legacyUtcSwitchImpact(legacyTime, SH, REF_MS)
      const legacyCfg = legacyTime ? { timeOfDay: legacyTime } : {}
      const switchedCfg = { timeOfDay: impact.toTimeOfDay, timezone: SH }
      const window = impact.dateTimeWindow as { start: string; end: string }
      const observedInside = new Set<number>()
      const observedOutside = new Set<number>()
      for (const cfg of CONFIGS) {
        // date field (floating literal day)
        for (const day of ['2026-09-30', '2026-01-01', '2026-12-31']) {
          const got = shiftDays(
            computeDateReminderOccurrence(day, { ...cfg, ...legacyCfg }, { floating: true }),
            computeDateReminderOccurrence(day, { ...cfg, ...switchedCfg }, { floating: true }),
          )
          expect(got, `date ${day}`).toBe(impact.dateFieldShiftDays)
        }
        // dateTime field: every 15 minutes across a UTC day
        for (let m = 0; m < 1440; m += 15) {
          const value = new Date(Date.UTC(2026, 8, 30, 0, m)).toISOString()
          const got = shiftDays(
            computeDateReminderOccurrence(value, { ...cfg, ...legacyCfg }),
            computeDateReminderOccurrence(value, { ...cfg, ...switchedCfg }),
          )
          const beijingMinutes = (m + 480) % 1440
          const [eh, em] = window.end.split(':').map(Number)
          const inside = beijingMinutes < eh * 60 + em
          expect(got, `dateTime ${value} (Beijing ${beijingMinutes} min)`).toBe(
            inside ? impact.dateTimeInsideShiftDays : impact.dateTimeOutsideShiftDays,
          )
          ;(inside ? observedInside : observedOutside).add(got)
        }
      }
      // the confirm text names exactly the shifts the backend produced
      const text = automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.date_field', impact, fieldType: null }, true)
      expect([...observedInside]).toEqual([impact.dateTimeInsideShiftDays])
      expect([...observedOutside]).toEqual([impact.dateTimeOutsideShiftDays])
      expect(text).toContain(`北京时间 00:00 至 08:00 之前的记录${zhShift(impact.dateTimeInsideShiftDays)}`)
      expect(text).toContain(`其余记录${zhShift(impact.dateTimeOutsideShiftDays)}`)
      expect(text).toContain(impact.dateFieldShiftDays === 0 ? '“日期”字段：每条提醒的时刻不变' : '“日期”字段：每条提醒都会比原来早一天')
    })
  }
})

// The first mount pays the editor's cold transform; allow slow CI runners more than the 5s default.
describe('A7a MetaAutomationRuleEditor schedule time', { timeout: 20_000 }, () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    useLocale().setLocale('en')
  })

  it('a new date reminder saves timezone Asia/Shanghai and the 24-hour value picked', async () => {
    useLocale().setLocale('zh-CN')
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave })
    await flushPromises()
    setName(container, 'Due reminder')
    epSetSelect(container.querySelector('[data-field="triggerType"]'), 'schedule.date_field')
    await flushPromises()
    epSetSelect(container.querySelector('[data-field="dateFieldId"]'), 'fld_due')
    await flushPromises()

    const timeSelect = container.querySelector('[data-field="timeOfDay"]') as HTMLElement
    expect(timeSelect).toBeTruthy()
    // not the native locale-driven input any more
    expect(container.querySelector('input[type="time"]')).toBeNull()
    const optionLabels = epOptions(timeSelect).map((option) => option.textContent?.trim() ?? '')
    expect(optionLabels).toContain('13:00')
    expect(optionLabels).toContain('23:45')
    expect(optionLabels.join(' ')).not.toMatch(/AM|PM|上午|下午/i)

    epSetSelect(timeSelect, '13:30')
    await flushPromises()
    expect(epSelectValue(timeSelect)).toBe('13:30')

    await save(container)
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerType).toBe('schedule.date_field')
    expect(payload.triggerConfig).toMatchObject({ dateFieldId: 'fld_due', timeOfDay: '13:30', timezone: 'Asia/Shanghai' })
    expect(payload.trigger?.config).toMatchObject({ timeOfDay: '13:30', timezone: 'Asia/Shanghai' })
  })

  it('an Asia/Shanghai reminder shows no UTC anywhere in the trigger section (zh + en)', async () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      useLocale().setLocale(locale)
      // new rule
      const fresh = mount({ visible: true, sheetId: 'sheet_1', fields })
      await flushPromises()
      epSetSelect(fresh.container.querySelector('[data-field="triggerType"]'), 'schedule.date_field')
      await flushPromises()
      expect(triggerSectionReadableText(fresh.container)).not.toMatch(/UTC/)
      expect(fresh.container.querySelector('[data-field="scheduleLegacyUtcNotice"]')).toBeNull()
      fresh.app.unmount()
      // saved Asia/Shanghai rule
      const saved = mount({
        visible: true,
        sheetId: 'sheet_1',
        fields,
        rule: savedRule({ triggerConfig: { dateFieldId: 'fld_due', offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: 'Asia/Shanghai' } }),
      })
      await flushPromises()
      expect(triggerSectionReadableText(saved.container)).not.toMatch(/UTC/)
      expect(saved.container.querySelector('[data-field="scheduleLegacyUtcNotice"]')).toBeNull()
      saved.app.unmount()
      document.body.innerHTML = ''
    }

    useLocale().setLocale('zh-CN')
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()
    epSetSelect(container.querySelector('[data-field="triggerType"]'), 'schedule.date_field')
    await flushPromises()
    expect(container.querySelector('[data-field="timeOfDayLabel"]')?.textContent?.trim()).toBe('提醒时间')
    expect(container.querySelector('[data-field="dateFieldTimeHint"]')?.textContent?.trim())
      .toBe('每天到这个时间（北京时间）检查一次，到期的记录会收到提醒；系统重启错过了，当天会补发。')
    const offset = container.querySelector('[data-field="offsetDays"]') as HTMLInputElement
    offset.value = '3'
    offset.dispatchEvent(new Event('input'))
    epSetSelect(container.querySelector('[data-field="timeOfDay"]'), '09:00')
    await flushPromises()
    expect(container.querySelector('[data-field="dateFieldTimeExample"]')?.textContent?.trim())
      .toBe('例：日期为 9月30日、提前 3 天 → 9月27日 09:00 提醒')
  })

  it('LEGACY-PRESERVE: renaming a saved UTC reminder keeps timezone absent and the same timeOfDay', async () => {
    useLocale().setLocale('zh-CN')
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: savedRule(), onSave })
    await flushPromises()

    // shown truthfully as UTC, with the explicit switch on offer
    expect(container.querySelector('[data-field="timeOfDayLabel"]')?.textContent?.trim()).toBe('提醒时间（UTC）')
    expect(epSelectValue(container.querySelector('[data-field="timeOfDay"]'))).toBe('01:00')
    const notice = container.querySelector('[data-field="scheduleLegacyUtcNotice"]')
    expect(notice?.textContent).toContain('01:00 UTC（北京时间 09:00）')
    expect(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]')?.textContent?.trim()).toBe('改为北京时间')

    setName(container, 'Legacy reminder (renamed)')
    await flushPromises()
    await save(container)
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.name).toBe('Legacy reminder (renamed)')
    expect(payload.triggerConfig.timeOfDay).toBe('01:00')
    expect('timezone' in payload.triggerConfig).toBe(false)
    expect(payload.trigger?.config && 'timezone' in payload.trigger.config).toBe(false)
  })

  it('LEGACY-PRESERVE: editing a saved UTC reminder time keeps it on UTC (no silent re-stamp)', async () => {
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: savedRule(), onSave })
    await flushPromises()
    epSetSelect(container.querySelector('[data-field="timeOfDay"]'), '02:00')
    await flushPromises()
    await save(container)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerConfig.timeOfDay).toBe('02:00')
    expect('timezone' in payload.triggerConfig).toBe(false)
  })

  it('改为北京时间 maps 01:00 UTC → 09:00 Asia/Shanghai after confirm; cancel changes nothing', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce(new Error('cancel'))
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: savedRule(), onSave })
    await flushPromises()

    // cancel → untouched
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(epSelectValue(container.querySelector('[data-field="timeOfDay"]'))).toBe('01:00')
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')).toBeTruthy()

    // confirm → converted
    confirmSpy.mockResolvedValueOnce('confirm' as never)
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    // fld_due is a `date` field → only the date sentence; 01:00 → 09:00 moves nothing
    expect(String(confirmSpy.mock.calls[1][0])).toBe('提醒时间将由 01:00 UTC 换算为北京时间 09:00。“日期”字段：每条提醒的时刻不变。')
    expect(epSelectValue(container.querySelector('[data-field="timeOfDay"]'))).toBe('09:00')
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')).toBeNull()
    expect(container.querySelector('[data-field="timeOfDayLabel"]')?.textContent?.trim()).toBe('提醒时间')
    expect(triggerSectionReadableText(container)).not.toMatch(/UTC/)

    await save(container)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerConfig).toMatchObject({ timeOfDay: '09:00', timezone: 'Asia/Shanghai' })
  })

  it('改为北京时间 on an empty time (the 09:00 UTC default) becomes 17:00; a late time warns it fires a day earlier', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const onSave = vi.fn()
    const empty = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: savedRule({ triggerConfig: { dateFieldId: 'fld_due', offsetDays: 1, direction: 'before' } }),
      onSave,
    })
    await flushPromises()
    ;(empty.container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    await save(empty.container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ timeOfDay: '17:00', timezone: 'Asia/Shanghai' })
    empty.app.unmount()

    const late = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: savedRule({ triggerConfig: { dateFieldId: 'fld_due', offsetDays: 1, direction: 'before', timeOfDay: '18:00' } }),
    })
    await flushPromises()
    ;(late.container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(String(confirmSpy.mock.calls[1][0])).toBe(
      '提醒时间将由 18:00 UTC 换算为北京时间 02:00（跨到次日）。“日期”字段：每条提醒都会比原来早一天。提醒日变了的记录，保存后可能会多提醒一次。',
    )
  })

  it('S1: a dateTime reminder at dayShift=1 gets the dateTime sentence (before 08:00 unchanged, others earlier), en', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: savedRule({ triggerConfig: { dateFieldId: 'fld_due_at', offsetDays: 0, direction: 'before', timeOfDay: '18:00' } }),
    })
    await flushPromises()
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(String(confirmSpy.mock.calls[0][0])).toBe(
      'The reminder time will be converted from 18:00 UTC to 02:00 Beijing time (the next day). '
      + 'On a "date & time" field, records whose Beijing time is before 08:00 fire at the same moment as before; '
      + 'all other records fire one day earlier than before. '
      + 'Records whose reminder day changes may get one extra reminder after you save.',
    )
  })

  it('S3: the customer’s legacy 04:33 UTC reminder shows 04:33, and a rename keeps 04:33 with no timezone', async () => {
    useLocale().setLocale('zh-CN')
    const onSave = vi.fn()
    const rule = savedRule({
      id: 'rule_customer',
      name: '到期提醒',
      triggerConfig: { dateFieldId: 'fld_due', offsetDays: 3, direction: 'before', timeOfDay: '04:33' },
    })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    const timeSelect = container.querySelector('[data-field="timeOfDay"]') as HTMLElement
    expect(epSelectValue(timeSelect)).toBe('04:33')
    // the off-grid stored value is a real, selected option — not snapped to 04:30/04:45
    expect(epOptions(timeSelect).filter((option) => option.value === '04:33')).toHaveLength(1)
    expect(container.querySelector('[data-field="timeOfDayLabel"]')?.textContent?.trim()).toBe('提醒时间（UTC）')
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')?.textContent)
      .toContain('这条规则创建较早，按 UTC 计时：当前提醒时间 04:33 UTC（北京时间 12:33）。可一键改为北京时间。')

    setName(container, '到期提醒（改名）')
    await flushPromises()
    await save(container)
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.name).toBe('到期提醒（改名）')
    expect(payload.triggerConfig.timeOfDay).toBe('04:33')
    expect('timezone' in payload.triggerConfig).toBe(false)
    expect(payload.trigger?.config && 'timezone' in payload.trigger.config).toBe(false)
  })

  it('cron: a new rule saves Asia/Shanghai and the daily preset says 00:00 北京时间', async () => {
    useLocale().setLocale('zh-CN')
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave })
    await flushPromises()
    setName(container, 'Nightly')
    epSetSelect(container.querySelector('[data-field="triggerType"]'), 'schedule.cron')
    await flushPromises()
    const cronSelect = container.querySelector('[data-field="cronPreset"]') as HTMLElement
    const daily = epOptions(cronSelect).find((option) => option.value === '0 0 * * *')
    expect(daily?.textContent?.trim()).toBe('每天 00:00（北京时间）')
    expect(triggerSectionReadableText(container)).not.toMatch(/UTC/)
    expect(triggerSectionReadableText(container)).not.toContain('午夜')
    epSetSelect(cronSelect, '0 0 * * *')
    await flushPromises()
    await save(container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ cron: '0 0 * * *', timezone: 'Asia/Shanghai' })
  })

  it('cron LEGACY-PRESERVE: renaming a saved UTC daily rule keeps its cron and no timezone; labels are truthful', async () => {
    useLocale().setLocale('zh-CN')
    const onSave = vi.fn()
    const rule = savedRule({ id: 'rule_cron', triggerType: 'schedule.cron', triggerConfig: { cron: '0 0 * * *' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    const cronSelect = container.querySelector('[data-field="cronPreset"]') as HTMLElement
    // opens on its OWN preset (it used to open on the stale hourly default and the save rewrote the cron)
    expect(epSelectValue(cronSelect)).toBe('0 0 * * *')
    expect(epOptions(cronSelect).find((option) => option.value === '0 0 * * *')?.textContent?.trim())
      .toBe('每天 00:00 UTC（北京时间 08:00）')
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')).toBeTruthy()

    setName(container, 'Nightly (renamed)')
    await flushPromises()
    await save(container)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerConfig.cron).toBe('0 0 * * *')
    expect('timezone' in payload.triggerConfig).toBe(false)
  })

  it('cron: a saved non-preset expression opens as custom and is saved verbatim', async () => {
    const onSave = vi.fn()
    const rule = savedRule({ id: 'rule_cron2', triggerType: 'schedule.cron', triggerConfig: { cron: '30 9 * * 1-5', timezone: 'Asia/Shanghai' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    expect(epSelectValue(container.querySelector('[data-field="cronPreset"]'))).toBe('custom')
    await save(container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ cron: '30 9 * * 1-5', timezone: 'Asia/Shanghai' })
  })

  it('cron 改为北京时间 keeps the expression and sets Asia/Shanghai; the confirm names this rule’s times', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const onSave = vi.fn()
    const rule = savedRule({ id: 'rule_cron3', triggerType: 'schedule.cron', triggerConfig: { cron: '0 0 * * *' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(String(confirmSpy.mock.calls[0][0])).toBe(
      'cron 表达式“0 0 * * *”不变，改按北京时间计时：原来在北京时间 08:00 执行，改后在北京时间 00:00 执行，每次都比原来早 8 小时。保存后生效。',
    )
    expect(epOptions(container.querySelector('[data-field="cronPreset"]')).find((option) => option.value === '0 0 * * *')?.textContent?.trim())
      .toBe('每天 00:00（北京时间）')
    await save(container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ cron: '0 0 * * *', timezone: 'Asia/Shanghai' })
  })

  it('S4: a legacy custom cron "0 1 * * *" shows 北京时间 09:00 and the confirm says 09:00 → 01:00, 8 hours earlier', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const onSave = vi.fn()
    const rule = savedRule({ id: 'rule_cron4', triggerType: 'schedule.cron', triggerConfig: { cron: '0 1 * * *' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    expect(epSelectValue(container.querySelector('[data-field="cronPreset"]'))).toBe('custom')
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')?.textContent)
      .toContain('这条规则创建较早，cron 表达式“0 1 * * *”按 UTC 计时，实际在北京时间 09:00 执行。可一键改为北京时间。')
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(String(confirmSpy.mock.calls[0][0])).toBe(
      'cron 表达式“0 1 * * *”不变，改按北京时间计时：原来在北京时间 09:00 执行，改后在北京时间 01:00 执行，每次都比原来早 8 小时。保存后生效。',
    )
    await save(container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ cron: '0 1 * * *', timezone: 'Asia/Shanghai' })
  })

  it('N1: a legacy every-5-minutes / hourly cron shows no UTC warning or switch, and a rename keeps it as is', async () => {
    useLocale().setLocale('zh-CN')
    for (const cron of ['*/5 * * * *', '0 * * * *']) {
      const onSave = vi.fn()
      const rule = savedRule({ id: `rule_${cron}`, triggerType: 'schedule.cron', triggerConfig: { cron } })
      const { container, app } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
      await flushPromises()
      expect(epSelectValue(container.querySelector('[data-field="cronPreset"]'))).toBe(cron)
      expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]'), cron).toBeNull()
      expect(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]'), cron).toBeNull()
      setName(container, `renamed ${cron}`)
      await flushPromises()
      await save(container)
      const payload = onSave.mock.calls[0][0] as AutomationRule
      expect(payload.triggerConfig.cron).toBe(cron)
      expect('timezone' in payload.triggerConfig).toBe(false)
      app.unmount()
      document.body.innerHTML = ''
    }
    // …but picking a clock-dependent preset on that legacy rule brings the warning back (it would run on UTC)
    const rule = savedRule({ id: 'rule_hourly', triggerType: 'schedule.cron', triggerConfig: { cron: '0 * * * *' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule })
    await flushPromises()
    epSetSelect(container.querySelector('[data-field="cronPreset"]'), '0 0 * * *')
    await flushPromises()
    expect(container.querySelector('[data-field="scheduleLegacyUtcNotice"]')?.textContent).toContain('实际在北京时间 08:00 执行')
  })
})
