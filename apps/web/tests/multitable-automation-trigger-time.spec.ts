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
  automationBusinessTimezone,
  convertLegacyUtcTimeOfDay,
  dateReminderExample,
  effectiveTriggerTimezone,
  isLegacyUtcScheduleRule,
  triggerTimeOfDayOptions,
  triggerTimezoneForSave,
  utcTimeOfDayInZone,
} from '../src/multitable/utils/automation-trigger-timezone'
import {
  automationCronPresetLabel,
  automationCronTimezoneHint,
  automationDateReminderExampleText,
  automationReminderTimeHint,
  automationReminderTimeLabel,
  automationSwitchToBusinessTimezoneConfirm,
} from '../src/multitable/utils/meta-automation-labels'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'
import { epOptions, epSelectValue, epSetSelect } from './helpers/epControls'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_name', name: 'Name', type: 'string' },
  { id: 'fld_due', name: 'Due date', type: 'date' },
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

  it('the switch confirm text carries the day-shift caveats', () => {
    const plain = automationSwitchToBusinessTimezoneConfirm(
      { triggerType: 'schedule.date_field', fromTimeOfDay: '01:00', toTimeOfDay: '09:00', dayShift: 0 },
      true,
    )
    expect(plain).toContain('01:00 UTC')
    expect(plain).toContain('09:00（北京时间）')
    expect(plain).toContain('00:00–08:00')
    expect(plain).toContain('相差一天')
    expect(plain).not.toContain('提前一天')
    const wrapped = automationSwitchToBusinessTimezoneConfirm(
      { triggerType: 'schedule.date_field', fromTimeOfDay: '18:00', toTimeOfDay: '02:00', dayShift: 1 },
      true,
    )
    expect(wrapped).toContain('次日')
    expect(wrapped).toContain('提前一天')
    const cron = automationSwitchToBusinessTimezoneConfirm({ triggerType: 'schedule.cron' }, true)
    expect(cron).toContain('cron 表达式不变')
    expect(cron).toContain('北京时间 08:00')
  })
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
    const message = String(confirmSpy.mock.calls[1][0])
    expect(message).toContain('01:00 UTC')
    expect(message).toContain('09:00（北京时间）')
    expect(message).toContain('相差一天')
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
    const message = String(confirmSpy.mock.calls[1][0])
    expect(message).toContain('18:00 UTC')
    expect(message).toContain('02:00（北京时间）')
    expect(message).toContain('提前一天')
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

  it('cron 改为北京时间 keeps the expression and sets Asia/Shanghai', async () => {
    useLocale().setLocale('zh-CN')
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const onSave = vi.fn()
    const rule = savedRule({ id: 'rule_cron3', triggerType: 'schedule.cron', triggerConfig: { cron: '0 0 * * *' } })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule, onSave })
    await flushPromises()
    ;(container.querySelector('[data-action="switchScheduleToBusinessTimezone"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(epOptions(container.querySelector('[data-field="cronPreset"]')).find((option) => option.value === '0 0 * * *')?.textContent?.trim())
      .toBe('每天 00:00（北京时间）')
    await save(container)
    expect(onSave.mock.calls[0][0].triggerConfig).toMatchObject({ cron: '0 0 * * *', timezone: 'Asia/Shanghai' })
  })
})
