import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import {
  buttonByText,
  emptyAttendanceResponse,
  flushUi,
  jsonResponse,
  recordApiCall,
  setCheckbox,
  setInput,
  setViewportWidth,
  type RecordedApiCall,
} from './helpers/attendanceA1Harness'

// A1 「提示与实际状态」 - mounted AttendanceView (admin mode). The leave-type and overtime-rule 「需要审批」 option is
// stored but NOT enforced, so the admin UI must say so (暂不生效 + explanation, header suffix, save note) while the
// control, its default, the stored Yes/No value and the POST/PUT body stay exactly what they were. Two classes of
// test live here on purpose:
//   - "hint" tests, which are RED on the base commit (no badge / hint / suffix / note exists there);
//   - "pin" tests (request body, ticked-save message, outdoor option untouched), which are GREEN on base and
//     prove nothing but the wording changed.

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

const LEAVE_TYPE_UNTICKED = {
  id: 'leave-type-1',
  code: 'annual_leave',
  name: 'Annual Leave',
  paid: true,
  requiresApproval: false,
  requiresAttachment: false,
  defaultMinutesPerDay: 480,
  isActive: true,
}
const OVERTIME_RULE_TICKED = {
  id: 'overtime-rule-1',
  name: 'Standard OT',
  minMinutes: 30,
  roundingMinutes: 15,
  maxMinutesPerDay: 240,
  requiresApproval: true,
  isActive: true,
}

describe('AttendanceView · 需要审批 is labelled as not in effect', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let writes: RecordedApiCall[] = []
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    writes = []
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const call = recordApiCall(input, init)
      if (call.url.includes('/api/attendance/leave-types')) {
        if (call.method !== 'GET') {
          writes.push(call)
          return jsonResponse(200, { ok: true, data: { id: 'leave-type-new' } })
        }
        return jsonResponse(200, { ok: true, data: { items: [LEAVE_TYPE_UNTICKED], total: 1 } })
      }
      if (call.url.includes('/api/attendance/overtime-rules')) {
        if (call.method !== 'GET') {
          writes.push(call)
          return jsonResponse(200, { ok: true, data: { id: 'overtime-rule-new' } })
        }
        return jsonResponse(200, { ok: true, data: { items: [OVERTIME_RULE_TICKED], total: 1 } })
      }
      return emptyAttendanceResponse()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView })
    }
    app = null
    container = null
    useLocale().setLocale('en')
  })

  async function mountAdmin(): Promise<HTMLElement> {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(10)
    return container!
  }

  function adminStatusText(root: HTMLElement): string {
    return root.querySelector('.attendance__status-block--admin .attendance__status')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  }

  // ---- leave types --------------------------------------------------------------------------------------

  it('leave types: the checkbox carries a 暂不生效 badge and an explanation that unticking does not skip approval', async () => {
    const root = await mountAdmin()
    const section = root.querySelector<HTMLElement>('#attendance-admin-leave-types')!
    expect(section).toBeTruthy()
    const badge = section.querySelector('[data-attendance-approval-option-badge="leave"]')
    expect(badge?.textContent?.trim()).toBe('Not in effect yet')
    // the badge sits inside the label of the 「需要审批」 control it qualifies
    expect(badge!.closest('label')?.getAttribute('for')).toBe('attendance-leave-approval')
    const hint = section.querySelector('[data-attendance-approval-option-hint="leave"]')
    expect(hint?.textContent).toContain('does not change how requests are submitted or approved')
    expect(hint?.textContent).toContain('unticking it does not skip approval')
    // the explanation is programmatically tied to the checkbox it qualifies
    const checkbox = root.querySelector<HTMLInputElement>('#attendance-leave-approval')!
    expect(checkbox.getAttribute('aria-describedby')).toBe(hint!.id)
    expect(hint!.id).toBe('attendance-leave-approval-note')
  })

  it('leave types: the control itself is unchanged - enabled, ticked by default, same id and name', async () => {
    const root = await mountAdmin()
    const checkbox = root.querySelector<HTMLInputElement>('#attendance-leave-approval')!
    expect(checkbox).toBeTruthy()
    expect(checkbox.type).toBe('checkbox')
    expect(checkbox.name).toBe('leaveRequiresApproval')
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(true)
  })

  it('leave types: the stored Yes/No column keeps its value but is headed "Approval (not in effect)"', async () => {
    const root = await mountAdmin()
    const header = root.querySelector('[data-attendance-approval-option-column="leave"]')
    expect(header?.textContent?.trim()).toBe('Approval (not in effect)')
    const row = Array.from(root.querySelectorAll('#attendance-admin-leave-types tbody tr'))
      .find((tr) => tr.textContent?.includes('annual_leave'))!
    const headers = Array.from(root.querySelectorAll('#attendance-admin-leave-types thead th')).map((th) => th.textContent?.trim())
    const cell = row.querySelectorAll('td')[headers.indexOf('Approval (not in effect)')]
    expect(cell.textContent?.trim()).toBe('No') // stored requiresApproval=false is still shown as stored
  })

  async function saveLeaveTypeUnticked(root: HTMLElement): Promise<void> {
    const section = root.querySelector<HTMLElement>('#attendance-admin-leave-types')!
    setInput(root, '#attendance-leave-code', 'sick_leave')
    setInput(root, '#attendance-leave-name', 'Sick Leave')
    setCheckbox(root, '#attendance-leave-approval', false)
    await flushUi(2)
    buttonByText(section, 'Create leave type').click()
    await flushUi(10)
  }

  it('PIN leave types: saving UNTICKED sends exactly the same POST body as before this slice', async () => {
    const root = await mountAdmin()
    await saveLeaveTypeUnticked(root)

    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('POST')
    expect(writes[0].url).toBe('/api/attendance/leave-types')
    // No new key, no renamed key. (`orgId` is the session org when one is resolved; it is undefined - hence
    // absent from the JSON - in this harness, so it is allowed but not required.)
    expect(Object.keys(writes[0].body!).filter((key) => key !== 'orgId').sort()).toEqual([
      'code', 'defaultMinutesPerDay', 'isActive', 'name', 'requiresApproval', 'requiresAttachment',
    ])
    expect(writes[0].body).toMatchObject({
      code: 'sick_leave',
      name: 'Sick Leave',
      requiresApproval: false,
      requiresAttachment: false,
      isActive: true,
    })
  })

  it('leave types: after saving UNTICKED the status says the option is not in effect and approval is still needed', async () => {
    const root = await mountAdmin()
    await saveLeaveTypeUnticked(root)
    const status = adminStatusText(root)
    expect(status).toContain('Leave type created.')
    expect(status).toContain('not in effect yet')
    expect(status).toContain('still need approval')
  })

  it('leave types: saving TICKED keeps the original status text exactly (nothing to correct)', async () => {
    const root = await mountAdmin()
    const section = root.querySelector<HTMLElement>('#attendance-admin-leave-types')!
    setInput(root, '#attendance-leave-code', 'personal_leave')
    setInput(root, '#attendance-leave-name', 'Personal Leave')
    await flushUi(2)
    buttonByText(section, 'Create leave type').click()
    await flushUi(10)

    expect(writes).toHaveLength(1)
    expect(writes[0].body).toMatchObject({ requiresApproval: true })
    expect(adminStatusText(root)).toBe('Leave type created.')
  })

  // ---- overtime rules -----------------------------------------------------------------------------------

  it('overtime rules: badge, explanation and column suffix, with the control unchanged', async () => {
    const root = await mountAdmin()
    const section = root.querySelector<HTMLElement>('#attendance-admin-overtime-rules')!
    expect(section).toBeTruthy()
    const badge = section.querySelector('[data-attendance-approval-option-badge="overtime"]')
    expect(badge?.textContent?.trim()).toBe('Not in effect yet')
    expect(badge!.closest('label')?.getAttribute('for')).toBe('attendance-overtime-approval')
    expect(section.querySelector('[data-attendance-approval-option-hint="overtime"]')?.textContent)
      .toContain('requests under this overtime rule are still submitted as pending')
    expect(root.querySelector('#attendance-overtime-approval')!.getAttribute('aria-describedby'))
      .toBe(section.querySelector('[data-attendance-approval-option-hint="overtime"]')!.id)
    expect(section.querySelector('[data-attendance-approval-option-column="overtime"]')?.textContent?.trim())
      .toBe('Approval (not in effect)')
    const checkbox = root.querySelector<HTMLInputElement>('#attendance-overtime-approval')!
    expect(checkbox.name).toBe('overtimeRequiresApproval')
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(true)
  })

  async function saveOvertimeRuleUnticked(root: HTMLElement): Promise<void> {
    const section = root.querySelector<HTMLElement>('#attendance-admin-overtime-rules')!
    setInput(root, '#attendance-overtime-name', 'Night OT')
    setCheckbox(root, '#attendance-overtime-approval', false)
    await flushUi(2)
    buttonByText(section, 'Create rule').click()
    await flushUi(10)
  }

  it('PIN overtime rules: saving UNTICKED sends exactly the same POST body as before this slice', async () => {
    const root = await mountAdmin()
    await saveOvertimeRuleUnticked(root)

    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('POST')
    expect(writes[0].url).toBe('/api/attendance/overtime-rules')
    expect(Object.keys(writes[0].body!).filter((key) => key !== 'orgId').sort()).toEqual([
      'isActive', 'maxMinutesPerDay', 'minMinutes', 'name', 'requiresApproval', 'roundingMinutes',
    ])
    expect(writes[0].body).toMatchObject({ name: 'Night OT', requiresApproval: false, isActive: true })
  })

  it('overtime rules: after saving UNTICKED the status says the option is not in effect and approval is still needed', async () => {
    const root = await mountAdmin()
    await saveOvertimeRuleUnticked(root)
    const status = adminStatusText(root)
    expect(status).toContain('Overtime rule created.')
    expect(status).toContain('not in effect yet')
    expect(status).toContain('still need approval')
  })

  it('overtime rules: saving TICKED keeps the original status text exactly', async () => {
    const root = await mountAdmin()
    const section = root.querySelector<HTMLElement>('#attendance-admin-overtime-rules')!
    setInput(root, '#attendance-overtime-name', 'Weekend OT')
    await flushUi(2)
    buttonByText(section, 'Create rule').click()
    await flushUi(10)

    expect(writes).toHaveLength(1)
    expect(writes[0].body).toMatchObject({ requiresApproval: true })
    expect(adminStatusText(root)).toBe('Overtime rule created.')
  })

  // ---- zh leg + the option that IS enforced --------------------------------------------------------------

  it('zh: the badge reads 暂不生效 and the column reads 审批(暂不生效)', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountAdmin()
    expect(root.querySelector('[data-attendance-approval-option-badge="leave"]')?.textContent?.trim()).toBe('暂不生效')
    expect(root.querySelector('[data-attendance-approval-option-badge="overtime"]')?.textContent?.trim()).toBe('暂不生效')
    expect(root.querySelector('[data-attendance-approval-option-column="leave"]')?.textContent?.trim()).toBe('审批(暂不生效)')
    expect(root.querySelector('[data-attendance-approval-option-hint="leave"]')?.textContent).toContain('取消勾选不会免除审批')
  })

  it('does not touch the outdoor-punch approval option, which IS enforced', async () => {
    const root = await mountAdmin()
    const label = Array.from(root.querySelectorAll('label'))
      .find((candidate) => candidate.textContent?.includes('Require approval for outdoor punches'))
    expect(label).toBeTruthy()
    expect(label!.textContent).not.toContain('Not in effect yet')
    expect(label!.querySelector('[data-attendance-approval-option-badge]')).toBeNull()
    // exactly the two not-in-effect badges exist on the whole page: leave type + overtime rule
    expect(root.querySelectorAll('[data-attendance-approval-option-badge]').length).toBe(2)
  })
})
