import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import { useLocale } from '../src/composables/useLocale'

function isoDate(offsetDays = 0): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

describe('MetaCalendarView', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('renders persisted default view and emits config changes when switching modes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateViewConfig = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Pilot',
                fld_start: isoDate(0),
                fld_end: isoDate(1),
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          viewConfig: {
            dateFieldId: 'fld_start',
            endDateFieldId: 'fld_end',
            titleFieldId: 'fld_title',
            defaultView: 'week',
            weekStartsOn: 1,
          },
          onUpdateViewConfig: updateViewConfig,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect((container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement).value).toBe('week')
    expect(container.querySelectorAll('.meta-calendar__cell').length).toBe(7)

    const modeSelect = container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement
    modeSelect.value = 'day'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateViewConfig).toHaveBeenCalledWith({
      config: expect.objectContaining({
        dateFieldId: 'fld_start',
        endDateFieldId: 'fld_end',
        titleFieldId: 'fld_title',
        defaultView: 'day',
        weekStartsOn: 1,
      }),
    })
    expect(container.querySelector('.meta-calendar__day-view')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('emits quick-create payload with start and end dates from the visible anchor day', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          viewConfig: {
            dateFieldId: 'fld_start',
            endDateFieldId: 'fld_end',
            titleFieldId: 'fld_title',
            defaultView: 'day',
          },
          onCreateRecord: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const button = container.querySelector('.meta-calendar__create-btn') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()

    const today = new Date()
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(createSpy).toHaveBeenCalledWith({
      fld_start: expectedDate,
      fld_end: expectedDate,
    })

    app.unmount()
    container.remove()
  })

  it('renders shared lunar and holiday metadata in the multitable calendar grid', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-03T12:00:00Z'))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const visibleRangeSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Contract renewal',
                fld_start: '2026-02-17',
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
          ],
          loading: false,
          calendarHolidays: [
            { id: 'holiday_spring', date: '2026-02-17', name: '春节', isWorkingDay: false },
            { id: 'working_sat', date: '2026-02-21', name: '调休', isWorkingDay: true },
          ],
          viewConfig: {
            dateFieldId: 'fld_start',
            titleFieldId: 'fld_title',
            defaultView: 'month',
            weekStartsOn: 0,
          },
          onVisibleRangeChange: visibleRangeSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('春节')
    expect(container.textContent).toContain('调休')
    expect(container.querySelector('.meta-calendar__lunar')?.textContent?.trim()).toBeTruthy()
    expect(visibleRangeSpy).toHaveBeenCalledWith({ from: '2026-02-01', to: '2026-03-14' })

    app.unmount()
    container.remove()
  })

  it('renders a calendar holiday sync notice when the workbench passes one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))

    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
          ],
          loading: false,
          calendarHolidayNotice: 'No public holiday data is synced for this range.',
          viewConfig: {
            dateFieldId: 'fld_start',
            titleFieldId: 'fld_title',
            defaultView: 'month',
            weekStartsOn: 0,
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const notice = container.querySelector('.meta-calendar__notice')
    expect(notice).not.toBeNull()
    expect(notice?.getAttribute('role')).toBe('status')
    expect(notice?.textContent).toContain('No public holiday data')

    app.unmount()
    container.remove()
  })

  // ===== Step 4 PR1: effective-calendar chip rendering =====
  // The 6 cases below pin the contract between Workbench (which maps API
  // items to CalendarEffectiveChip) and MetaCalendarView (which renders the
  // chip with tooltip + override/overlay markers). UI is scope C (minimal):
  //   - existing --working / --rest classes unchanged
  //   - calendar_policy override -> --overridden + title tooltip with chain
  //   - overlay present -> --with-overlay + overlay summary in tooltip
  //   - legacy chips (no effective/base/layers/overlays) keep working with no
  //     tooltip and no override marker (backward-compat for PR2 callers).
  function mountChipCalendar(holidays: any[]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
          ],
          loading: false,
          calendarHolidays: holidays,
          viewConfig: {
            dateFieldId: 'fld_start',
            titleFieldId: 'fld_title',
            defaultView: 'month',
            weekStartsOn: 0,
          },
        })
      },
    })
    app.mount(container)
    return { app, container }
  }
  function findChipByText(container: HTMLElement, text: string): HTMLElement | null {
    return Array.from(container.querySelectorAll('.meta-calendar__holiday')).find(
      (el) => el.textContent?.trim() === text,
    ) as HTMLElement | null
  }

  it('§4-PR1 case 1: national base chip renders with tooltip naming effective.source=national, no override marker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      {
        id: 'h_nat',
        date: '2026-10-01',
        name: 'National Day',
        isWorkingDay: false,
        base: { isWorkingDay: false, source: 'national', name: 'National Day', holidayId: 'h_nat' },
        effective: { isWorkingDay: false, source: 'national', label: 'National Day' },
        layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' }],
        overlays: [],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'National Day')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('meta-calendar__holiday--rest')).toBe(true)
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(false)
    expect(chip!.classList.contains('meta-calendar__holiday--with-overlay')).toBe(false)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('2026-10-01')
    expect(title).toContain('national')
    expect(title).toContain('Rest day')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 2: org override on national gets --overridden + tooltip names both layers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      {
        id: 'pol_org_1',
        date: '2026-10-05',
        name: 'Org swap',
        isWorkingDay: true,
        base: { isWorkingDay: false, source: 'national', name: 'National Day', holidayId: 'h_nat_5' },
        effective: { isWorkingDay: true, source: 'org', label: 'Org swap', policyId: 'pol_org_1' },
        layers: [
          { kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' },
          { kind: 'calendar_policy', source: 'org', isWorkingDay: true, label: 'Org swap', refId: 'pol_org_1' },
        ],
        overlays: [],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'Org swap')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('meta-calendar__holiday--working')).toBe(true)
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(true)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('national:')
    expect(title).toContain('National Day')
    expect(title).toContain('org:')
    expect(title).toContain('Org swap')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 3: group-source override marks --overridden with group layer in tooltip', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      {
        id: 'pol_grp_1',
        date: '2026-10-05',
        name: 'Production rest',
        isWorkingDay: false,
        base: { isWorkingDay: true, source: 'rule' },
        effective: { isWorkingDay: false, source: 'group', label: 'Production rest', policyId: 'pol_grp_1' },
        layers: [
          { kind: 'base_rule', source: 'rule', isWorkingDay: true },
          { kind: 'calendar_policy', source: 'group', isWorkingDay: false, label: 'Production rest', refId: 'pol_grp_1' },
        ],
        overlays: [],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'Production rest')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('meta-calendar__holiday--rest')).toBe(true)
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(true)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('group:')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 4: user-source override marks --overridden with user layer in tooltip', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      {
        id: 'pol_usr_1',
        date: '2026-10-05',
        name: 'User confirm',
        isWorkingDay: true,
        base: { isWorkingDay: false, source: 'national', name: 'National Day', holidayId: 'h_5' },
        effective: { isWorkingDay: true, source: 'user', label: 'User confirm', policyId: 'pol_usr_1' },
        layers: [
          { kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' },
          { kind: 'calendar_policy', source: 'user', isWorkingDay: true, label: 'User confirm', refId: 'pol_usr_1' },
        ],
        overlays: [],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'User confirm')
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(true)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('user:')
    expect(title).toContain('User confirm')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 5: overlay-present chip gets --with-overlay class and overlay summary in tooltip', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      {
        id: 'h_overlay_day',
        date: '2026-08-15',
        name: 'Leave + OT',
        isWorkingDay: false,
        base: { isWorkingDay: false, source: 'manual', name: 'Manual rest', holidayId: 'h_man_1' },
        effective: { isWorkingDay: false, source: 'manual', label: 'Leave + OT' },
        layers: [{ kind: 'holiday', source: 'manual', isWorkingDay: false, label: 'Manual rest' }],
        overlays: [
          { kind: 'personal_leave', source: 'attendance_requests', requestType: 'leave', minutes: 240, status: 'approved', refId: 'req_1' },
          { kind: 'overtime', source: 'attendance_requests', requestType: 'overtime', minutes: 180, status: 'approved', refId: 'req_2' },
        ],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'Leave + OT')
    expect(chip!.classList.contains('meta-calendar__holiday--with-overlay')).toBe(true)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('Overlays:')
    expect(title).toContain('personal_leave')
    expect(title).toContain('240m')
    expect(title).toContain('overtime')
    expect(title).toContain('180m')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 5b: overlay-only rule day renders the overlay label (not generic "Working day") and keeps --with-overlay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))

    // Workbench maps via effectiveCalendarItemToChip which now falls back to
    // the first overlay's kind label when neither effective.label nor
    // base.name is set — typical scenario: plain Mon-Fri workday with an
    // approved leave request and no calendar_policy override.
    const { app, container } = mountChipCalendar([
      {
        id: '2026-08-15|rule|',
        date: '2026-08-15',
        name: 'Leave',
        isWorkingDay: true,
        base: { isWorkingDay: true, source: 'rule' },
        effective: { isWorkingDay: true, source: 'rule' },
        layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: true }],
        overlays: [
          { kind: 'personal_leave', source: 'attendance_requests', requestType: 'leave', minutes: 240, status: 'approved', refId: 'req_l' },
        ],
      },
    ])
    await nextTick()

    const chip = findChipByText(container, 'Leave')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('meta-calendar__holiday--working')).toBe(true)
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(false)
    expect(chip!.classList.contains('meta-calendar__holiday--with-overlay')).toBe(true)
    // No generic "Working day" fallback should be shown
    expect(chip!.textContent?.includes('Working day')).toBe(false)
    const title = chip!.getAttribute('title') ?? ''
    expect(title).toContain('personal_leave')
    expect(title).toContain('240m')

    app.unmount()
    container.remove()
  })

  it('§4-PR1 case 6: legacy CalendarHoliday payload (no effective/layers) renders without tooltip or override marker (backward-compat for PR2)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-18T00:00:00Z'))

    const { app, container } = mountChipCalendar([
      { id: 'legacy_1', date: '2026-02-17', name: 'Legacy spring', isWorkingDay: false },
    ])
    await nextTick()

    const chip = findChipByText(container, 'Legacy spring')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('meta-calendar__holiday--rest')).toBe(true)
    expect(chip!.classList.contains('meta-calendar__holiday--overridden')).toBe(false)
    expect(chip!.classList.contains('meta-calendar__holiday--with-overlay')).toBe(false)
    // buildHolidayTooltip returns undefined for legacy payloads -> title attribute absent or empty
    const title = chip!.getAttribute('title')
    expect(title === null || title === '').toBe(true)

    app.unmount()
    container.remove()
  })

  it('localizes calendar view chrome while keeping event and holiday names raw', async () => {
    useLocale().setLocale('zh-CN')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-03T12:00:00Z'))

    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Contract renewal',
                fld_start: '2026-02-17',
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          calendarHolidays: [
            { id: 'holiday_spring', date: '2026-02-17', name: '春节', isWorkingDay: false },
          ],
          viewConfig: {
            dateFieldId: 'fld_start',
            titleFieldId: 'fld_title',
            defaultView: 'month',
            weekStartsOn: 0,
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('今天')
    expect(container.textContent).toContain('+ 添加记录')
    expect(container.textContent).toContain('视图')
    expect(container.textContent).toContain('更改')
    expect(container.textContent).toContain('春节')
    expect(container.textContent).toContain('Contract renewal')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(42)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)
    expect(container.querySelector('.meta-calendar__cell')?.getAttribute('aria-label')).toContain('2026年')

    app.unmount()
  })
})
