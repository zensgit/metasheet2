import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AttendanceAdminTaskHome from '../src/views/attendance/AttendanceAdminTaskHome.vue'

type Group = {
  key: string
  title: string
  detail: string
  linkActions: Array<{ key: string; label: string; href: string; primary?: boolean }>
  buttonActions: Array<{ key: string; label: string; sectionId: string; primary?: boolean }>
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FOUR_GROUPS: Group[] = [
  {
    key: 'daily-operations',
    title: 'Daily operations',
    detail: 'Approvals, anomalies, imports, and audit follow-up.',
    linkActions: [
      { key: 'pending-attendance-approvals', label: 'Pending approvals', href: '/attendance?section=attendance-overview-requests', primary: true },
      { key: 'attendance-anomalies', label: 'Anomalies', href: '/attendance?section=attendance-overview-anomalies' },
    ],
    buttonActions: [
      { key: 'daily-import', label: 'Import', sectionId: 'attendance-admin-import' },
      { key: 'audit-follow-up', label: 'Audit logs', sectionId: 'attendance-admin-audit-logs' },
    ],
  },
  {
    key: 'people-groups',
    title: 'People and attendance groups',
    detail: 'Groups, members, owners, access, and availability.',
    linkActions: [],
    buttonActions: [
      { key: 'attendance-groups', label: 'Attendance groups', sectionId: 'attendance-admin-groups', primary: true },
      { key: 'group-members', label: 'Members', sectionId: 'attendance-admin-group-members' },
    ],
  },
  {
    key: 'work-time-policies',
    title: 'Work time and policies',
    detail: 'Shifts, schedules, holidays, rule sets, overtime, and leave policies.',
    linkActions: [],
    buttonActions: [
      { key: 'shifts', label: 'Shifts', sectionId: 'attendance-admin-shifts', primary: true },
      { key: 'holidays', label: 'Holidays', sectionId: 'attendance-admin-holidays' },
    ],
  },
  {
    key: 'reporting-payroll',
    title: 'Reporting and payroll',
    detail: 'Import batches, report fields, payroll templates, and payroll cycles.',
    linkActions: [],
    buttonActions: [
      { key: 'import-batches', label: 'Import batches', sectionId: 'attendance-admin-import-batches', primary: true },
      { key: 'payroll-cycles', label: 'Payroll cycles', sectionId: 'attendance-admin-payroll-cycles' },
    ],
  },
]

describe('AttendanceAdminTaskHome', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mount(overrides: { groups?: Group[] } = {}) {
    const onSelectSection = vi.fn()
    const onNavigate = vi.fn()
    app = createApp(AttendanceAdminTaskHome, {
      tr: (en: string) => en,
      groups: overrides.groups ?? FOUR_GROUPS,
      onSelectSection: onSelectSection,
      onNavigate: onNavigate,
    })
    app.mount(container!)
    return { onSelectSection, onNavigate }
  }

  it('renders the header, region semantics, and the four task groups in order', async () => {
    mount()
    await flushUi()

    const root = container!.querySelector('[data-admin-task-home="true"]')
    expect(root).toBeTruthy()
    expect(root?.getAttribute('role')).toBe('region')
    expect(root?.getAttribute('aria-labelledby')).toBe('attendance-admin-task-home-title')

    const title = container!.querySelector('#attendance-admin-task-home-title')
    expect(title).toBeTruthy()
    expect(title?.textContent).toContain('Operations and configuration')
    expect(title?.getAttribute('tabindex')).toBe('-1')
    expect(root?.textContent).toContain('Attendance management')
    expect(root?.textContent).toContain('Daily work, people, policies, reporting, and payroll')

    const groupKeys = Array.from(root!.querySelectorAll('[data-admin-task-group]')).map(el => el.getAttribute('data-admin-task-group'))
    expect(groupKeys).toEqual(['daily-operations', 'people-groups', 'work-time-policies', 'reporting-payroll'])
    expect(root?.textContent).toContain('Daily operations')
    expect(root?.textContent).toContain('Approvals, anomalies, imports, and audit follow-up.')
  })

  it('renders link actions as real anchors that do not go through the select-section emit path', async () => {
    mount()
    await flushUi()

    const anomalyLink = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="attendance-anomalies"]')
    expect(anomalyLink?.tagName).toBe('A')
    expect(anomalyLink?.getAttribute('href')).toBe('/attendance?section=attendance-overview-anomalies')
    expect(anomalyLink?.classList.contains('attendance__btn--primary')).toBe(false)

    const primaryLink = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="pending-attendance-approvals"]')
    expect(primaryLink?.classList.contains('attendance__btn--primary')).toBe(true)
  })

  it('a plain left-click on a link action prevents the default navigation and emits navigate (fix 4)', async () => {
    const { onNavigate } = mount()
    await flushUi()

    const anomalyLink = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="attendance-anomalies"]')
    expect(anomalyLink).toBeTruthy()

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault')
    anomalyLink!.dispatchEvent(clickEvent)
    await flushUi()

    // A real <a href> left-click that reaches jsdom's default action would attempt a full
    // document navigation ("Not implemented: navigation to another Document"). The component
    // calls preventDefault() itself and emits `navigate` with the href instead, so the PARENT
    // (AttendanceView.vue's onAdminTaskHomeNavigate) can route it through the SPA router.
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith('/attendance?section=attendance-overview-anomalies')
  })

  it('does not intercept a modifier-clicked link action (open-in-new-tab stays native)', async () => {
    const { onNavigate } = mount()
    await flushUi()

    const anomalyLink = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="attendance-anomalies"]')
    const ctrlClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    const preventDefaultSpy = vi.spyOn(ctrlClick, 'preventDefault')
    anomalyLink!.dispatchEvent(ctrlClick)
    await flushUi()

    expect(preventDefaultSpy).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not intercept a non-primary-button click (e.g. middle-click open-in-new-tab)', async () => {
    const { onNavigate } = mount()
    await flushUi()

    const anomalyLink = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="attendance-anomalies"]')
    const middleClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 })
    const preventDefaultSpy = vi.spyOn(middleClick, 'preventDefault')
    anomalyLink!.dispatchEvent(middleClick)
    await flushUi()

    expect(preventDefaultSpy).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('emits select-section with the section id when a button action is clicked', async () => {
    const { onSelectSection } = mount()
    await flushUi()

    const importButton = container!.querySelector<HTMLButtonElement>('[data-admin-task-action="daily-import"]')
    expect(importButton?.tagName).toBe('BUTTON')
    importButton!.click()
    await flushUi()

    expect(onSelectSection).toHaveBeenCalledTimes(1)
    expect(onSelectSection).toHaveBeenCalledWith('attendance-admin-import')

    const shiftsButton = container!.querySelector<HTMLButtonElement>('[data-admin-task-action="shifts"]')
    expect(shiftsButton?.classList.contains('attendance__btn--primary')).toBe(true)
    shiftsButton!.click()
    await flushUi()

    expect(onSelectSection).toHaveBeenCalledTimes(2)
    expect(onSelectSection).toHaveBeenLastCalledWith('attendance-admin-shifts')
  })

  it('renders no group cards when the parent passes an empty (permission-filtered) list', async () => {
    mount({ groups: [] })
    await flushUi()

    expect(container!.querySelectorAll('[data-admin-task-group]')).toHaveLength(0)
    const root = container!.querySelector('[data-admin-task-home="true"]')
    expect(root).toBeTruthy()
    expect(root?.textContent).toContain('Attendance management')
  })
})
